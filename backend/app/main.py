from __future__ import annotations

import hmac
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from starlette.concurrency import run_in_threadpool

from . import admin_totp
from .audit import write_audit
from .config import settings
from .crypto import KeyUnavailableError, decrypt_seed, encrypt_seed, get_master_key
from .db import database, initialize_database
from .dependencies import SESSION_COOKIE, require_admin
from .schemas import (
    BootstrapRequest,
    CallerCreate,
    CallerUpdate,
    DeleteRequest,
    EntryCreate,
    EntryUpdate,
    LoginRequest,
    PasswordChangeRequest,
    RevokeRequest,
    TotpCodeRequest,
    TotpDisableRequest,
)
from .network import is_loopback, normalize_ip, origin_allowed, resolve_client_ip
from .security import (
    ARGON2_WAIT_SECONDS,
    PasswordCheckBusy,
    admin_failure_window,
    clock_monitor,
    hash_password,
    hash_secret,
    iso_now,
    make_opaque_token,
    NEVER_EXPIRES,
    rate_limiter,
    caller_expiry,
    caller_is_expired,
    session_expiry,
    verify_password,
)
from .totp import (
    InvalidTotpError,
    TotpDefinition,
    generate_code,
    normalize_seed,
    parse_otpauth_uri,
    validate_parameters,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    get_master_key()
    yield


app = FastAPI(
    title="AuthTOTP",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=list(settings.allowed_hosts),
)


@app.exception_handler(PasswordCheckBusy)
async def password_check_busy(_: Request, __: PasswordCheckBusy) -> JSONResponse:
    """All Argon2 slots stayed busy for the whole wait (login, bootstrap, password change, TOTP disable).

    The attempt has already used its per-source rate-limit budget; nothing was checked, so it is
    neither audited nor counted as a credential failure, and any open transaction was rolled back.
    """
    return JSONResponse(
        status_code=429,
        content={"detail": "RATE_LIMITED"},
        headers={"Retry-After": str(int(ARGON2_WAIT_SECONDS))},
    )


NO_STORE = "no-store"
IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable"
# Vite 6 / Rollup 4 default: assets/[name]-[hash].[ext], 8-char base64url hash.
_HASHED_ASSET_NAME = re.compile(r".+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+")


def _is_hashed_asset(dist: Path, file_path: Path) -> bool:
    return file_path.parent == dist / "assets" and bool(_HASHED_ASSET_NAME.fullmatch(file_path.name))


def _final_cache_control(path: str, route_value: str | None) -> str:
    """Fail closed: only a verified hashed file under /assets/ may keep the long cache."""
    if path.startswith("/assets/") and route_value == IMMUTABLE_ASSET_CACHE:
        return IMMUTABLE_ASSET_CACHE
    return NO_STORE


def _error(status: int, code: str, message: str, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}, "request_id": request_id},
    )


def _entry_public(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "label": row["label"],
        "issuer": row["issuer"],
        "account_ref": row["account_ref"],
        "purpose": row["purpose"],
        "algorithm": row["algorithm"],
        "digits": row["digits"],
        "period_seconds": row["period_seconds"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "caller_count": row["caller_count"] if "caller_count" in row.keys() else 0,
    }


def _caller_public(connection: Any, row: Any) -> dict[str, Any]:
    entries = connection.execute(
        "SELECT entry_id FROM caller_entries WHERE caller_id = ? ORDER BY entry_id",
        (row["id"],),
    ).fetchall()
    expired = caller_is_expired(row["expires_at"])
    return {
        "id": row["id"],
        "name": row["name"],
        "purpose": row["purpose"],
        "token_hint": row["token_hint"],
        "status": "expired" if row["status"] == "active" and expired else row["status"],
        "expires_at": None if row["expires_at"] == NEVER_EXPIRES else row["expires_at"],
        "allowed_entry_ids": [entry["entry_id"] for entry in entries],
        "created_at": row["created_at"],
        "revoked_at": row["revoked_at"],
    }


CSRF_COOKIE = "authtotp_csrf"


def _set_session_cookie(response: Response, session: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session,
        max_age=settings.session_hours * 3600,
        httponly=True,
        samesite="strict",
        secure=settings.cookie_secure,
        path="/",
    )


def _set_csrf_cookie(response: Response, csrf: str) -> None:
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=settings.session_hours * 3600,
        httponly=False,
        samesite="strict",
        secure=settings.cookie_secure,
        path="/",
    )


def _set_session_cookies(response: Response, session: str, csrf: str) -> None:
    _set_session_cookie(response, session)
    _set_csrf_cookie(response, csrf)


def _response_sets_session_cookie(response: Response) -> bool:
    prefix = f"{SESSION_COOKIE}=".encode("latin-1")
    return any(
        name.lower() == b"set-cookie" and value.startswith(prefix)
        for name, value in response.raw_headers
    )


SESSION_RENEW_INTERVAL = timedelta(hours=24)


def _renewal_threshold(session_hours: int) -> timedelta:
    """Renew when remaining lifetime drops below this.

    Long lifetimes (> 48 h): renew once more than 24 h have passed since issue/renewal, i.e.
    remaining < H - 24 h, so a session expires 23-24 h short of H after the last use while
    writing at most once per session per day. Short lifetimes (<= 48 h): H - 24 h would be
    <= H/2 (never renewing at all when H <= 24), so fall back to "less than half left".
    """
    lifetime = timedelta(hours=session_hours)
    return max(lifetime - SESSION_RENEW_INTERVAL, lifetime / 2)


def _maybe_renew_session(request: Request, response: Response, info: dict[str, str]) -> None:
    """Sliding renewal: once remaining lifetime is below the threshold, extend and re-issue cookies.

    Runs after the handler, for success and error responses alike, so the stored expiry and
    the browser cookie always move together. The CSRF value is kept (not rotated) so requests
    already in flight and other tabs holding the current token keep passing double-submit.
    """
    expires_at = datetime.fromisoformat(info["expires_at"]).astimezone(UTC)
    if expires_at - datetime.now(UTC) >= _renewal_threshold(settings.session_hours):
        return
    if _response_sets_session_cookie(response):
        return  # the handler already set or deleted the session cookie (e.g. logout)
    with database() as connection:
        renewed = connection.execute(
            "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
            (session_expiry(settings.session_hours), info["token_hash"]),
        ).rowcount
    if renewed != 1:
        return  # session was deleted while handling this request; never resurrect it
    _set_session_cookie(response, info["token"])
    csrf = request.cookies.get(CSRF_COOKIE)
    if csrf and hmac.compare_digest(hash_secret(csrf), info["csrf_hash"]):
        _set_csrf_cookie(response, csrf)


def _create_session(connection: Any, response: Response) -> None:
    session = make_opaque_token("ats_")
    csrf = make_opaque_token("atc_")
    now = iso_now()
    connection.execute(
        """
        INSERT INTO sessions(token_hash, csrf_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (hash_secret(session), hash_secret(csrf), session_expiry(settings.session_hours), now, now),
    )
    _set_session_cookies(response, session, csrf)


def _audit_source(request: Request) -> str:
    """Real source IP: XFF is honoured only when the direct peer is a trusted proxy."""
    return resolve_client_ip(
        request.client.host if request.client else None,
        request.headers.getlist("x-forwarded-for"),
        settings.trusted_proxies,
    )


_FORWARDING_HEADERS = ("x-forwarded-for", "forwarded", "x-real-ip")


def _is_local_admin_source(request: Request, source: str) -> bool:
    """Loopback gate for first-time setup and sign-in before the second factor is bound.

    - A loopback peer that is not a configured trusted proxy but still carries forwarding headers
      is a reverse proxy the operator forgot to list: the request really comes from elsewhere.
    - A trusted proxy that names the client only via X-Real-IP / Forwarded (no X-Forwarded-For,
      which is the only header the source resolution reads) leaves `source` at the proxy's own
      loopback address; the client is still remote.
    Neither is local. An SSH tunnel sends none of these headers and stays local.
    """
    if not is_loopback(source):
        return False
    peer = normalize_ip(request.client.host) if request.client else None
    if peer is None:
        return True
    headers = request.headers
    if peer not in settings.trusted_proxies:
        return not (is_loopback(peer) and any(name in headers for name in _FORWARDING_HEADERS))
    has_xff = any(value.strip() for value in headers.getlist("x-forwarded-for"))
    return has_xff or not ("x-real-ip" in headers or "forwarded" in headers)


def _ensure_admin_unlocked(source: str) -> None:
    """Global admin-failure lock; loopback sources (local console / SSH tunnel) are exempt."""
    if is_loopback(source):
        return
    retry_after = admin_failure_window.retry_after()
    if retry_after:
        raise HTTPException(
            status_code=429, detail="LOGIN_LOCKED", headers={"Retry-After": str(retry_after)}
        )


def _record_admin_failure(source: str) -> None:
    if not is_loopback(source):
        admin_failure_window.record()


def _revoke_other_sessions(connection: Any, request: Request) -> None:
    """Drop every admin session except the one making this request."""
    current = request.cookies.get(SESSION_COOKIE)
    if current:
        connection.execute("DELETE FROM sessions WHERE token_hash != ?", (hash_secret(current),))


def _definition_from_payload(payload: EntryCreate) -> TotpDefinition:
    if payload.otpauth_uri:
        parsed = parse_otpauth_uri(payload.otpauth_uri)
        return TotpDefinition(
            seed=parsed.seed,
            label=(payload.label or parsed.label).strip(),
            issuer=(payload.issuer if payload.issuer is not None else parsed.issuer).strip(),
            account_ref=(
                payload.account_ref if payload.account_ref is not None else parsed.account_ref
            ).strip(),
            algorithm=parsed.algorithm,
            digits=parsed.digits,
            period_seconds=parsed.period_seconds,
        )
    assert payload.secret is not None
    validate_parameters(payload.algorithm, payload.digits, payload.period_seconds)
    return TotpDefinition(
        seed=normalize_seed(payload.secret),
        label=(payload.label or "未命名条目").strip(),
        issuer=(payload.issuer or "").strip(),
        account_ref=(payload.account_ref or "").strip(),
        algorithm=payload.algorithm,
        digits=payload.digits,
        period_seconds=payload.period_seconds,
    )


_CLIENT_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")


def _request_id(supplied: str | None) -> str:
    """Echo a well-formed client X-Request-ID; anything else (too long, odd bytes) gets a fresh uuid4."""
    if supplied and _CLIENT_REQUEST_ID.fullmatch(supplied):
        return supplied
    return str(uuid.uuid4())


@app.middleware("http")
async def security_and_request_id(request: Request, call_next):
    request.state.request_id = _request_id(request.headers.get("X-Request-ID"))
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/"):
        origin = request.headers.get("Origin")
        if origin and request.headers.get("host") != "testserver":
            if not origin_allowed(origin, request.headers.get("host"), settings.allowed_origins):
                return _error(403, "ORIGIN_REJECTED", "请求来源不受信任。", request.state.request_id)
    response = await call_next(request)
    admin_session = getattr(request.state, "admin_session", None)
    if admin_session is not None and response.status_code < 500:
        await run_in_threadpool(_maybe_renew_session, request, response, admin_session)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cache-Control"] = _final_cache_control(
        request.url.path, response.headers.get("Cache-Control")
    )
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    return response


@app.get("/health")
def health() -> dict[str, Any]:
    with database() as connection:
        bootstrapped = connection.execute("SELECT 1 FROM admin_auth WHERE id = 1").fetchone()
        connection.execute("SELECT 1").fetchone()
    clock_healthy = clock_monitor.ensure_healthy()
    return {
        "status": "ok" if clock_healthy else "degraded",
        "clock_healthy": clock_healthy,
        "bootstrapped": bool(bootstrapped),
    }


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict[str, bool]:
    cookie = request.cookies.get(SESSION_COOKIE)
    authenticated = False
    with database() as connection:
        bootstrapped = bool(connection.execute("SELECT 1 FROM admin_auth WHERE id = 1").fetchone())
        if cookie:
            row = connection.execute(
                "SELECT expires_at FROM sessions WHERE token_hash = ?", (hash_secret(cookie),)
            ).fetchone()
            authenticated = bool(
                row and datetime.fromisoformat(row["expires_at"]).astimezone(UTC) > datetime.now(UTC)
            )
        totp_enrolled = admin_totp.is_enrolled(connection)
    return {
        "bootstrapped": bootstrapped,
        "authenticated": authenticated,
        "totp_enrolled": totp_enrolled,
        "totp_required": settings.require_admin_totp,
    }


@app.post("/api/auth/bootstrap")
def bootstrap(payload: BootstrapRequest, request: Request, response: Response) -> dict[str, bool]:
    source = _audit_source(request)
    # Per-source limit first: requests over it get 429 and write nothing, so the denial
    # audit below cannot be used to flood the audit table from one source.
    if not rate_limiter.allow(f"bootstrap:{source}", 5, 300):
        raise HTTPException(status_code=429, detail="RATE_LIMITED")
    if settings.require_admin_totp and not _is_local_admin_source(request, source):
        with database() as connection:
            write_audit(
                connection,
                request_id=request.state.request_id,
                actor_type="admin",
                actor_id="local-admin",
                action="admin.bootstrap",
                result="denied",
                reason="bootstrap_local_only",
                source=source,
            )
        # Raised after the audit transaction has committed.
        raise HTTPException(status_code=403, detail="BOOTSTRAP_LOCAL_ONLY")
    with database() as connection:
        if connection.execute("SELECT 1 FROM admin_auth WHERE id = 1").fetchone():
            raise HTTPException(status_code=409, detail="ALREADY_BOOTSTRAPPED")
        now = iso_now()
        connection.execute(
            "INSERT INTO admin_auth(id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)",
            (hash_password(payload.password), now, now),
        )
        _create_session(connection, response)
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="admin.bootstrap",
            result="success",
            source=source,
        )
    return {"ok": True}


@app.post("/api/auth/login")
def login(payload: LoginRequest, request: Request, response: Response) -> dict[str, bool]:
    source = _audit_source(request)
    _ensure_admin_unlocked(source)
    code = (payload.code or "").strip()
    failure: HTTPException | None = None
    with database() as connection:
        enrolled = admin_totp.is_enrolled(connection)
        if enrolled and not code:
            # Answered before any password check so it reveals nothing and costs no attempt.
            raise HTTPException(status_code=400, detail="TOTP_CODE_REQUIRED")
        if not rate_limiter.allow(f"login:{source}", 8, 300):
            raise HTTPException(status_code=429, detail="RATE_LIMITED")
        row = connection.execute("SELECT password_hash FROM admin_auth WHERE id = 1").fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="BOOTSTRAP_REQUIRED")
        if not enrolled and settings.require_admin_totp and not _is_local_admin_source(request, source):
            write_audit(
                connection,
                request_id=request.state.request_id,
                actor_type="admin",
                actor_id="local-admin",
                action="admin.login",
                result="denied",
                reason="admin_totp_not_enrolled",
                source=source,
            )
            failure = HTTPException(status_code=403, detail="ADMIN_TOTP_NOT_ENROLLED")
        else:
            password_ok = verify_password(row["password_hash"], payload.password)
            match: admin_totp.CodeMatch | None = None
            if enrolled:
                # Always evaluated so timing does not reveal whether the password was right.
                try:
                    match = admin_totp.find_code_match(connection, code)
                except KeyUnavailableError as exc:
                    raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
            reason: str | None = None
            if not password_ok:
                reason = "invalid_password"
            elif enrolled and (match is None or not admin_totp.consume(connection, match)):
                reason = "invalid_second_factor"
            if reason:
                _record_admin_failure(source)
                write_audit(
                    connection,
                    request_id=request.state.request_id,
                    actor_type="admin",
                    actor_id="local-admin",
                    action="admin.login",
                    result="denied",
                    reason=reason,
                    source=source,
                )
                failure = HTTPException(
                    status_code=401, detail="INVALID_CREDENTIALS" if enrolled else "INVALID_PASSWORD"
                )
            else:
                _create_session(connection, response)
                write_audit(
                    connection,
                    request_id=request.state.request_id,
                    actor_type="admin",
                    actor_id="local-admin",
                    action="admin.login",
                    result="success",
                    reason=match.kind if match else None,
                    source=source,
                )
    # Raised after the transaction commits so denial audits are persisted.
    if failure:
        raise failure
    return {"ok": True}


def _audit_admin(
    connection: Any, request: Request, action: str, result: str, reason: str | None = None
) -> None:
    write_audit(
        connection,
        request_id=request.state.request_id,
        actor_type="admin",
        actor_id="local-admin",
        action=action,
        result=result,
        reason=reason,
        source=_audit_source(request),
    )


def _second_factor_rate_limit(request: Request) -> None:
    if not rate_limiter.allow(f"totp-verify:{_audit_source(request)}", 8, 300):
        raise HTTPException(status_code=429, detail="RATE_LIMITED")


@app.post("/api/auth/password")
def change_password(
    payload: PasswordChangeRequest,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, bool]:
    source = _audit_source(request)
    _ensure_admin_unlocked(source)
    # Pure input check before anything is verified or consumed (a valid TOTP step or
    # recovery code must not be burned by a request that is then rejected).
    if hmac.compare_digest(
        payload.new_password.encode("utf-8"), payload.current_password.encode("utf-8")
    ):
        raise HTTPException(status_code=400, detail="PASSWORD_UNCHANGED")
    code = (payload.code or "").strip()
    failure: HTTPException | None = None
    with database() as connection:
        enrolled = admin_totp.is_enrolled(connection)
        if enrolled and not code:
            # Same as login: answered before any password check, costs no attempt.
            raise HTTPException(status_code=400, detail="TOTP_CODE_REQUIRED")
        _second_factor_rate_limit(request)
        row = connection.execute("SELECT password_hash FROM admin_auth WHERE id = 1").fetchone()
        password_ok = bool(row) and verify_password(row["password_hash"], payload.current_password)
        match: admin_totp.CodeMatch | None = None
        if enrolled:
            try:
                match = admin_totp.find_code_match(connection, code)
            except KeyUnavailableError as exc:
                raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
        reason: str | None = None
        if not password_ok:
            reason = "invalid_password"
        elif enrolled and (match is None or not admin_totp.consume(connection, match)):
            reason = "invalid_second_factor"
        if reason:
            _record_admin_failure(source)
            _audit_admin(connection, request, "admin.password.change", "denied", reason)
            failure = HTTPException(status_code=400, detail="INVALID_CREDENTIALS")
        else:
            connection.execute(
                "UPDATE admin_auth SET password_hash = ?, updated_at = ? WHERE id = 1",
                (hash_password(payload.new_password), iso_now()),
            )
            _revoke_other_sessions(connection, request)
            _audit_admin(
                connection, request, "admin.password.change", "success", match.kind if match else None
            )
    if failure:
        raise failure
    return {"ok": True}


@app.post("/api/auth/totp/setup")
def totp_setup(
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, str]:
    with database() as connection:
        if admin_totp.is_enrolled(connection):
            raise HTTPException(status_code=409, detail="TOTP_ALREADY_ENROLLED")
        try:
            result = admin_totp.begin_setup(connection)
        except KeyUnavailableError as exc:
            raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
        _audit_admin(connection, request, "admin.totp.setup", "success")
    return result


@app.post("/api/auth/totp/confirm")
def totp_confirm(
    payload: TotpCodeRequest,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, list[str]]:
    source = _audit_source(request)
    _ensure_admin_unlocked(source)
    failure: HTTPException | None = None
    codes: list[str] = []
    with database() as connection:
        if admin_totp.is_enrolled(connection):
            raise HTTPException(status_code=409, detail="TOTP_ALREADY_ENROLLED")
        if not admin_totp.has_pending(connection):
            raise HTTPException(status_code=409, detail="TOTP_SETUP_REQUIRED")
        _second_factor_rate_limit(request)
        try:
            step = admin_totp.match_pending(connection, payload.code)
            if step is None:
                _record_admin_failure(source)
                _audit_admin(connection, request, "admin.totp.confirm", "denied", "invalid_code")
                failure = HTTPException(status_code=400, detail="INVALID_TOTP_CODE")
            elif not admin_totp.activate_pending(connection, step):
                raise HTTPException(status_code=409, detail="TOTP_ALREADY_ENROLLED")
            else:
                codes = admin_totp.replace_recovery_codes(connection)
                _revoke_other_sessions(connection, request)
                _audit_admin(connection, request, "admin.totp.confirm", "success")
        except KeyUnavailableError as exc:
            raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
    if failure:
        raise failure
    return {"recovery_codes": codes}


@app.post("/api/auth/totp/disable")
def totp_disable(
    payload: TotpDisableRequest,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, bool]:
    source = _audit_source(request)
    _ensure_admin_unlocked(source)
    failure: HTTPException | None = None
    with database() as connection:
        if not admin_totp.is_enrolled(connection):
            raise HTTPException(status_code=409, detail="TOTP_NOT_ENROLLED")
        _second_factor_rate_limit(request)
        row = connection.execute("SELECT password_hash FROM admin_auth WHERE id = 1").fetchone()
        password_ok = bool(row) and verify_password(row["password_hash"], payload.password)
        try:
            match = admin_totp.find_code_match(connection, payload.code)
        except KeyUnavailableError as exc:
            raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
        reason: str | None = None
        if not password_ok:
            reason = "invalid_password"
        elif match is None or not admin_totp.consume(connection, match):
            reason = "invalid_second_factor"
        if reason:
            _record_admin_failure(source)
            _audit_admin(connection, request, "admin.totp.disable", "denied", reason)
            failure = HTTPException(status_code=400, detail="INVALID_CREDENTIALS")
        else:
            admin_totp.disable(connection)
            _revoke_other_sessions(connection, request)
            _audit_admin(connection, request, "admin.totp.disable", "success", match.kind)
    if failure:
        raise failure
    return {"ok": True}


@app.post("/api/auth/recovery-codes/regenerate")
def regenerate_recovery_codes(
    payload: TotpCodeRequest,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, list[str]]:
    source = _audit_source(request)
    _ensure_admin_unlocked(source)
    failure: HTTPException | None = None
    codes: list[str] = []
    with database() as connection:
        if not admin_totp.is_enrolled(connection):
            raise HTTPException(status_code=409, detail="TOTP_NOT_ENROLLED")
        _second_factor_rate_limit(request)
        try:
            match = admin_totp.find_code_match(connection, payload.code)
            if match is None or not admin_totp.consume(connection, match):
                _record_admin_failure(source)
                _audit_admin(
                    connection, request, "admin.recovery_codes.regenerate", "denied", "invalid_code"
                )
                failure = HTTPException(status_code=400, detail="INVALID_TOTP_CODE")
            else:
                codes = admin_totp.replace_recovery_codes(connection)
                _revoke_other_sessions(connection, request)
                _audit_admin(
                    connection, request, "admin.recovery_codes.regenerate", "success", match.kind
                )
        except KeyUnavailableError as exc:
            raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
    if failure:
        raise failure
    return {"recovery_codes": codes}


@app.post("/api/auth/logout")
def logout(
    request: Request,
    response: Response,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, bool]:
    cookie = request.cookies.get(SESSION_COOKIE)
    with database() as connection:
        if cookie:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_secret(cookie),))
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="admin.logout",
            result="success",
            source=_audit_source(request),
        )
    response.delete_cookie(
        SESSION_COOKIE, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict"
    )
    response.delete_cookie(
        "authtotp_csrf", path="/", secure=settings.cookie_secure, samesite="strict"
    )
    return {"ok": True}


@app.get("/api/entries")
def list_entries(_: dict[str, str] = Depends(require_admin)) -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute(
            """
            SELECT e.*, COUNT(CASE WHEN c.status = 'active' AND c.expires_at > ? THEN 1 END) AS caller_count
            FROM entries e
            LEFT JOIN caller_entries ce ON ce.entry_id = e.id
            LEFT JOIN callers c ON c.id = ce.caller_id
            GROUP BY e.id
            ORDER BY e.updated_at DESC
            """,
            (iso_now(),),
        ).fetchall()
    return [_entry_public(row) for row in rows]


@app.post("/api/entries", status_code=201)
def create_entry(
    payload: EntryCreate,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, Any]:
    try:
        definition = _definition_from_payload(payload)
    except InvalidTotpError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not definition.label:
        raise HTTPException(status_code=422, detail="条目名称不能为空。")
    entry_id = f"totp_{uuid.uuid4().hex}"
    now = iso_now()
    with database() as connection:
        existing_rows = connection.execute("SELECT id, seed_ciphertext FROM entries").fetchall()
        for existing in existing_rows:
            try:
                if hmac.compare_digest(
                    decrypt_seed(existing["seed_ciphertext"], existing["id"]), definition.seed
                ):
                    raise HTTPException(status_code=409, detail="DUPLICATE_TOTP_SECRET")
            except KeyUnavailableError as exc:
                raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
        try:
            encrypted = encrypt_seed(definition.seed, entry_id)
        except KeyUnavailableError as exc:
            raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
        connection.execute(
            """
            INSERT INTO entries
                (id, label, issuer, account_ref, purpose, algorithm, digits,
                 period_seconds, seed_ciphertext, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            """,
            (
                entry_id,
                definition.label,
                definition.issuer,
                definition.account_ref,
                payload.purpose,
                definition.algorithm,
                definition.digits,
                definition.period_seconds,
                encrypted,
                now,
                now,
            ),
        )
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="entry.create",
            entry_id=entry_id,
            result="success",
            source=_audit_source(request),
        )
        row = connection.execute(
            "SELECT e.*, 0 AS caller_count FROM entries e WHERE id = ?", (entry_id,)
        ).fetchone()
    return _entry_public(row)


@app.patch("/api/entries/{entry_id}")
def update_entry(
    entry_id: str,
    payload: EntryUpdate,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, Any]:
    values = payload.model_dump(exclude_none=True)
    if not values:
        raise HTTPException(status_code=422, detail="NO_CHANGES")
    allowed = {"label", "issuer", "account_ref", "purpose", "status"}
    if set(values) - allowed:
        raise HTTPException(status_code=422, detail="UNSUPPORTED_CHANGE")
    assignments = ", ".join(f"{column} = ?" for column in values)
    with database() as connection:
        cursor = connection.execute(
            f"UPDATE entries SET {assignments}, updated_at = ? WHERE id = ?",  # noqa: S608
            (*values.values(), iso_now(), entry_id),
        )
        if cursor.rowcount != 1:
            raise HTTPException(status_code=404, detail="ENTRY_NOT_FOUND")
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="entry.update",
            entry_id=entry_id,
            result="success",
            reason=",".join(values.keys()),
            source=_audit_source(request),
        )
        row = connection.execute(
            """
            SELECT e.*, COUNT(CASE WHEN c.status = 'active' AND c.expires_at > ? THEN 1 END) AS caller_count
            FROM entries e
            LEFT JOIN caller_entries ce ON ce.entry_id = e.id
            LEFT JOIN callers c ON c.id = ce.caller_id
            WHERE e.id = ? GROUP BY e.id
            """,
            (iso_now(), entry_id),
        ).fetchone()
    return _entry_public(row)


@app.delete("/api/entries/{entry_id}")
def delete_entry(
    entry_id: str,
    payload: DeleteRequest,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, bool]:
    with database() as connection:
        row = connection.execute("SELECT status FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ENTRY_NOT_FOUND")
        if row["status"] != "disabled":
            raise HTTPException(status_code=409, detail="DISABLE_BEFORE_DELETE")
        connection.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="entry.delete",
            entry_id=entry_id,
            result="success",
            source=_audit_source(request),
        )
    return {"ok": True}


@app.post("/api/entries/{entry_id}/code")
def admin_code(
    entry_id: str,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, Any]:
    if not clock_monitor.ensure_healthy():
        raise HTTPException(status_code=503, detail="CLOCK_UNHEALTHY")
    with database() as connection:
        row = connection.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="ENTRY_NOT_FOUND")
        if row["status"] != "active":
            raise HTTPException(status_code=409, detail="ENTRY_DISABLED")
        try:
            seed = decrypt_seed(row["seed_ciphertext"], entry_id)
            code_data = generate_code(seed, row["algorithm"], row["digits"], row["period_seconds"])
            # The vault card rolls straight into the following window's code when the current one expires,
            # so one view = one audit row. Only this owner endpoint returns it; /v1 callers never do.
            next_data = generate_code(
                seed,
                row["algorithm"],
                row["digits"],
                row["period_seconds"],
                at=code_data["valid_until_epoch"],
            )
        except KeyUnavailableError as exc:
            raise HTTPException(status_code=503, detail="KEY_UNAVAILABLE") from exc
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="code.read",
            entry_id=entry_id,
            result="success",
            source=_audit_source(request),
        )
    response = _format_code_response(entry_id, code_data, request.state.request_id)
    response["next"] = {
        "code": next_data["code"],
        "valid_from": datetime.fromtimestamp(next_data["valid_from_epoch"], UTC).isoformat(),
        "valid_until": datetime.fromtimestamp(next_data["valid_until_epoch"], UTC).isoformat(),
    }
    return response


def _format_code_response(entry_id: str, code_data: dict[str, Any], request_id: str) -> dict[str, Any]:
    valid_from = datetime.fromtimestamp(code_data.pop("valid_from_epoch"), UTC).isoformat()
    valid_until = datetime.fromtimestamp(code_data.pop("valid_until_epoch"), UTC).isoformat()
    return {
        "entry_id": entry_id,
        **code_data,
        "valid_from": valid_from,
        "valid_until": valid_until,
        "refresh_recommended": code_data["remaining_seconds"]
        < settings.code_min_remaining_seconds,
        "request_id": request_id,
    }


@app.get("/api/meta")
def get_meta(_: dict[str, str] = Depends(require_admin)) -> dict[str, int]:
    """Server defaults the admin UI needs (0 = caller tokens never expire)."""
    return {"caller_token_default_hours": max(settings.caller_token_hours, 0)}


@app.get("/api/callers")
def list_callers(_: dict[str, str] = Depends(require_admin)) -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute("SELECT * FROM callers ORDER BY created_at DESC").fetchall()
        result = [_caller_public(connection, row) for row in rows]
    return result


def _replace_caller_entries(connection: Any, caller_id: str, entry_ids: list[str]) -> None:
    unique_ids = list(dict.fromkeys(entry_ids))
    if unique_ids:
        placeholders = ",".join("?" for _ in unique_ids)
        count = connection.execute(
            f"SELECT COUNT(*) AS count FROM entries WHERE id IN ({placeholders})",  # noqa: S608
            unique_ids,
        ).fetchone()["count"]
        if count != len(unique_ids):
            raise HTTPException(status_code=422, detail="UNKNOWN_ENTRY_IN_ALLOWLIST")
    connection.execute("DELETE FROM caller_entries WHERE caller_id = ?", (caller_id,))
    connection.executemany(
        "INSERT INTO caller_entries(caller_id, entry_id) VALUES (?, ?)",
        [(caller_id, entry_id) for entry_id in unique_ids],
    )


@app.post("/api/callers", status_code=201)
def create_caller(
    payload: CallerCreate,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, Any]:
    caller_id = f"caller_{uuid.uuid4().hex}"
    raw_token = make_opaque_token("ttb_live_")
    expiry_from = "default" if payload.expires_in_hours is None else "request"
    # 0 (or a non-positive server default) = never expires.
    expires_in_hours = max(
        settings.caller_token_hours if payload.expires_in_hours is None else payload.expires_in_hours, 0
    )
    with database() as connection:
        connection.execute(
            """
            INSERT INTO callers
                (id, name, purpose, token_hash, token_hint, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            """,
            (
                caller_id,
                payload.name.strip(),
                payload.purpose.strip(),
                hash_secret(raw_token),
                f"…{raw_token[-6:]}",
                iso_now(),
                caller_expiry(expires_in_hours),
            ),
        )
        _replace_caller_entries(connection, caller_id, payload.allowed_entry_ids)
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="caller.create",
            result="success",
            reason=(
                f"allowlist_count={len(set(payload.allowed_entry_ids))}"
                f" expires_in_hours={expires_in_hours} expiry_from={expiry_from}"
            ),
            source=_audit_source(request),
        )
        row = connection.execute("SELECT * FROM callers WHERE id = ?", (caller_id,)).fetchone()
        public = _caller_public(connection, row)
    return {**public, "token": raw_token}


@app.patch("/api/callers/{caller_id}")
def update_caller(
    caller_id: str,
    payload: CallerUpdate,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, Any]:
    values = payload.model_dump(exclude_none=True)
    with database() as connection:
        if not connection.execute("SELECT 1 FROM callers WHERE id = ?", (caller_id,)).fetchone():
            raise HTTPException(status_code=404, detail="CALLER_NOT_FOUND")
        allowed_entry_ids = values.pop("allowed_entry_ids", None)
        if values:
            assignments = ", ".join(f"{column} = ?" for column in values)
            connection.execute(
                f"UPDATE callers SET {assignments} WHERE id = ?",  # noqa: S608
                (*values.values(), caller_id),
            )
        if allowed_entry_ids is not None:
            _replace_caller_entries(connection, caller_id, allowed_entry_ids)
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="caller.update",
            result="success",
            source=_audit_source(request),
        )
        row = connection.execute("SELECT * FROM callers WHERE id = ?", (caller_id,)).fetchone()
        public = _caller_public(connection, row)
    return public


@app.post("/api/callers/{caller_id}/revoke")
def revoke_caller(
    caller_id: str,
    payload: RevokeRequest,
    request: Request,
    _: dict[str, str] = Depends(require_admin),
) -> dict[str, bool]:
    with database() as connection:
        cursor = connection.execute(
            "UPDATE callers SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'",
            (iso_now(), caller_id),
        )
        if cursor.rowcount != 1:
            raise HTTPException(status_code=404, detail="ACTIVE_CALLER_NOT_FOUND")
        write_audit(
            connection,
            request_id=request.state.request_id,
            actor_type="admin",
            actor_id="local-admin",
            action="caller.revoke",
            result="success",
            source=_audit_source(request),
        )
    return {"ok": True}


@app.get("/api/audit")
def list_audit(
    limit: int = 100,
    _: dict[str, str] = Depends(require_admin),
) -> list[dict[str, Any]]:
    safe_limit = min(max(limit, 1), 500)
    with database() as connection:
        rows = connection.execute(
            "SELECT * FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ?", (safe_limit,)
        ).fetchall()
    return [dict(row) for row in rows]


# Every /v1 code request from one source (valid or not), counted before the caller token is looked at.
V1_SOURCE_LIMIT = 60
V1_SOURCE_WINDOW_SECONDS = 60


@app.post("/v1/totp/{entry_id}/code", response_model=None)
def caller_code(
    entry_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
) -> JSONResponse | dict[str, Any]:
    rid = request.state.request_id
    source = _audit_source(request)
    # Per-source limit before any token check: requests over it get 429 and write nothing, so
    # anonymous calls with bogus tokens cannot grow the audit table without bound from one source.
    if not rate_limiter.allow(f"v1-source:{source}", V1_SOURCE_LIMIT, V1_SOURCE_WINDOW_SECONDS):
        limited = _error(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。", rid)
        limited.headers["Retry-After"] = str(V1_SOURCE_WINDOW_SECONDS)
        return limited
    if not authorization or not authorization.startswith("Bearer "):
        return _error(401, "UNAUTHENTICATED", "缺少调用方凭据。", rid)
    raw_token = authorization[7:].strip()
    token_hash = hash_secret(raw_token)
    with database() as connection:
        caller = connection.execute(
            "SELECT * FROM callers WHERE token_hash = ?", (token_hash,)
        ).fetchone()
        caller_expired = bool(caller and caller_is_expired(caller["expires_at"]))
        if not caller or caller["status"] != "active" or caller_expired:
            write_audit(
                connection,
                request_id=rid,
                actor_type="caller",
                action="code.read",
                result="denied",
                reason="expired_caller" if caller_expired else "invalid_caller",
                source=source,
            )
            return _error(401, "UNAUTHENTICATED", "调用方凭据无效或已撤销。", rid)
        if not rate_limiter.allow(
            f"code:{caller['id']}:{entry_id}", settings.rate_limit_per_minute
        ):
            return _error(429, "RATE_LIMITED", "取码请求过于频繁。", rid)
        row = connection.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            return _error(404, "ENTRY_NOT_FOUND", "条目不存在。", rid)
        allowed = connection.execute(
            "SELECT 1 FROM caller_entries WHERE caller_id = ? AND entry_id = ?",
            (caller["id"], entry_id),
        ).fetchone()
        if not allowed:
            write_audit(
                connection,
                request_id=rid,
                actor_type="caller",
                actor_id=caller["id"],
                action="code.read",
                entry_id=entry_id,
                result="denied",
                reason="caller_not_allowed",
                source=source,
            )
            return _error(403, "CALLER_NOT_ALLOWED", "调用方未获该条目权限。", rid)
        if row["status"] != "active":
            return _error(409, "ENTRY_DISABLED", "该条目当前不可用。", rid)
        if not clock_monitor.ensure_healthy():
            return _error(503, "CLOCK_UNHEALTHY", "系统时钟状态异常。", rid)
        try:
            code_data = generate_code(
                decrypt_seed(row["seed_ciphertext"], entry_id),
                row["algorithm"],
                row["digits"],
                row["period_seconds"],
            )
        except KeyUnavailableError:
            return _error(503, "KEY_UNAVAILABLE", "主密钥当前不可用。", rid)
        write_audit(
            connection,
            request_id=rid,
            actor_type="caller",
            actor_id=caller["id"],
            action="code.read",
            entry_id=entry_id,
            result="success",
            source=source,
        )
    return _format_code_response(entry_id, code_data, rid)


V1_METHOD_NOT_ALLOWED_MESSAGE = "这是取码接口，请用 POST 调用；在浏览器里取码请打开发给你的取码页链接。"


# Registered after POST /v1/totp/{entry_id}/code (so it keeps matching first) and before the
# SPA catch-all, so nothing under /v1 ever falls back to the frontend HTML.
@app.api_route(
    "/v1",
    methods=["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
    include_in_schema=False,
    response_model=None,
)
@app.api_route(
    "/v1/{rest:path}",
    methods=["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
    include_in_schema=False,
    response_model=None,
)
def v1_method_not_allowed(request: Request) -> JSONResponse:
    response = _error(
        405, "METHOD_NOT_ALLOWED", V1_METHOD_NOT_ALLOWED_MESSAGE, request.state.request_id
    )
    response.headers["Allow"] = "POST"
    return response


@app.post("/v1", include_in_schema=False, response_model=None)
@app.post("/v1/{rest:path}", include_in_schema=False, response_model=None)
def v1_not_found(request: Request) -> JSONResponse:
    return _error(404, "NOT_FOUND", "接口不存在。", request.state.request_id)


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str) -> FileResponse:
    dist = settings.frontend_dist.resolve()
    requested = (dist / path).resolve()
    if path and requested.is_relative_to(dist) and requested.is_file():
        response = FileResponse(requested)
        if _is_hashed_asset(dist, requested):
            # Content-hashed build output never changes under the same name.
            response.headers["Cache-Control"] = IMMUTABLE_ASSET_CACHE
        return response
    index = dist / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(status_code=503, detail="FRONTEND_NOT_BUILT")
