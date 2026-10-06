from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Cookie, Header, HTTPException, Request

from .db import database
from .security import hash_secret, iso_now


SESSION_COOKIE = "authtotp_session"


def request_id(request: Request) -> str:
    return request.state.request_id


def require_admin(
    request: Request,
    authtotp_session: str | None = Cookie(default=None),
    x_csrf_token: str | None = Header(default=None),
) -> dict[str, str]:
    if not authtotp_session:
        raise HTTPException(status_code=401, detail="ADMIN_SESSION_REQUIRED")
    expired = False
    with database() as connection:
        row = connection.execute(
            "SELECT * FROM sessions WHERE token_hash = ?",
            (hash_secret(authtotp_session),),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="ADMIN_SESSION_REQUIRED")
        if datetime.fromisoformat(row["expires_at"]).astimezone(UTC) <= datetime.now(UTC):
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
            expired = True
        else:
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                if not x_csrf_token or hash_secret(x_csrf_token) != row["csrf_hash"]:
                    raise HTTPException(status_code=403, detail="CSRF_CHECK_FAILED")
            connection.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
                (iso_now(), row["token_hash"]),
            )
    if expired:
        # Raised after the transaction commits so the expired row is really deleted.
        raise HTTPException(status_code=401, detail="ADMIN_SESSION_EXPIRED")
    # Read by the HTTP middleware, which decides on sliding renewal once the response exists.
    request.state.admin_session = {
        "token": authtotp_session,
        "token_hash": row["token_hash"],
        "csrf_hash": row["csrf_hash"],
        "expires_at": row["expires_at"],
    }
    return {"actor_type": "admin", "actor_id": "local-admin"}

