"""Item 4: administrator TOTP second factor, recovery codes, loopback-only bootstrap login, global cap."""

from __future__ import annotations

import re
import time
from dataclasses import replace
from urllib.parse import parse_qs, urlparse

import pyotp
import pytest
from fastapi.testclient import TestClient

from backend.app import admin_totp as admin_totp_module
from backend.app import main as main_module
from backend.app.admin_totp import ADMIN_TOTP_BINDING
from backend.app.config import settings
from backend.app.crypto import decrypt_seed
from backend.app.db import database
from backend.app.main import app
from backend.app.security import admin_failure_window


PASSWORD = "correct horse battery staple"
RECOVERY_FORMAT = re.compile(r"[A-Z2-9]{4}-[A-Z2-9]{4}")


class FakeTime:
    def __init__(self, now: float) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


@pytest.fixture()
def frozen_time(monkeypatch):
    """Pin the admin TOTP clock to the start of a 30 s step so step arithmetic is deterministic."""
    fake = FakeTime((int(time.time()) // 30) * 30 + 1)
    monkeypatch.setattr(admin_totp_module, "time", fake)
    return fake


def code_for(secret: str, at: float) -> str:
    return pyotp.TOTP(secret).at(at)


def wrong_code(secret: str, at: float) -> str:
    valid = {code_for(secret, at + 30 * offset) for offset in (-1, 0, 1)}
    return next(candidate for candidate in ("000000", "111111", "222222", "333333") if candidate not in valid)


def visitor(ip: str = "203.0.113.10") -> TestClient:
    return TestClient(app, client=(ip, 50000))


def login(via: TestClient, password: str = PASSWORD, code: str | None = None, headers: dict | None = None):
    body = {"password": password}
    if code is not None:
        body["code"] = code
    return via.post("/api/auth/login", json=body, headers=headers or {})


def enroll(admin_client, now: float) -> tuple[str, list[str]]:
    setup = admin_client.post("/api/auth/totp/setup")
    assert setup.status_code == 200, setup.text
    secret = setup.json()["secret_base32"]
    confirm = admin_client.post("/api/auth/totp/confirm", json={"code": code_for(secret, now)})
    assert confirm.status_code == 200, confirm.text
    return secret, confirm.json()["recovery_codes"]


def raw_database_bytes() -> bytes:
    """Main SQLite file plus WAL/SHM, so recent writes not yet checkpointed are scanned too."""
    path = settings.database_path
    parts = [path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")]
    return b"".join(part.read_bytes() for part in parts if part.exists())


def audit_rows() -> list[dict]:
    with database() as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM audit_events ORDER BY id")]


def require_totp(monkeypatch, **extra) -> None:
    monkeypatch.setattr(
        main_module, "settings", replace(main_module.settings, require_admin_totp=True, **extra)
    )


# ---- status / setup / confirm ------------------------------------------------------------


def test_status_reports_totp_flags(client, monkeypatch):
    status = client.get("/api/auth/status").json()
    assert status == {
        "bootstrapped": False,
        "authenticated": False,
        "totp_enrolled": False,
        "totp_required": False,
    }
    require_totp(monkeypatch)
    assert client.get("/api/auth/status").json()["totp_required"] is True


def test_totp_endpoints_require_session_and_csrf(client):
    assert client.post("/api/auth/totp/setup").status_code == 401
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    for path, body in [
        ("/api/auth/totp/setup", None),
        ("/api/auth/totp/confirm", {"code": "123456"}),
        ("/api/auth/totp/disable", {"password": PASSWORD, "code": "123456"}),
        ("/api/auth/recovery-codes/regenerate", {"code": "123456"}),
    ]:
        response = client.post(path, json=body)
        assert response.status_code == 403, path
        assert response.json()["detail"] == "CSRF_CHECK_FAILED"


def test_setup_returns_uri_and_stores_seed_encrypted(admin_client):
    response = admin_client.post("/api/auth/totp/setup")
    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"otpauth_uri", "secret_base32"}
    secret = payload["secret_base32"]
    parsed = urlparse(payload["otpauth_uri"])
    query = parse_qs(parsed.query)
    assert parsed.scheme == "otpauth" and parsed.netloc == "totp"
    assert parsed.path == "/AuthTOTP:vault"
    assert query["secret"] == [secret]
    assert query["issuer"] == ["AuthTOTP"]
    assert len(secret) == 32
    with database() as connection:
        row = connection.execute("SELECT * FROM admin_totp WHERE id = 1").fetchone()
    assert row["seed_ciphertext"] is None
    assert row["pending_seed_ciphertext"].startswith(b"AT02")
    assert decrypt_seed(row["pending_seed_ciphertext"], ADMIN_TOTP_BINDING) == secret
    assert secret.encode("ascii") not in raw_database_bytes()
    assert admin_client.get("/api/auth/status").json()["totp_enrolled"] is False


def test_setup_again_replaces_pending_seed(admin_client, frozen_time):
    first = admin_client.post("/api/auth/totp/setup").json()["secret_base32"]
    second = admin_client.post("/api/auth/totp/setup").json()["secret_base32"]
    assert first != second
    stale = admin_client.post("/api/auth/totp/confirm", json={"code": code_for(first, frozen_time.now)})
    assert stale.status_code == 400
    assert stale.json()["detail"] == "INVALID_TOTP_CODE"
    confirmed = admin_client.post("/api/auth/totp/confirm", json={"code": code_for(second, frozen_time.now)})
    assert confirmed.status_code == 200
    codes = confirmed.json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10
    assert all(RECOVERY_FORMAT.fullmatch(code) for code in codes)
    with database() as connection:
        row = connection.execute("SELECT * FROM admin_totp WHERE id = 1").fetchone()
        stored_hashes = [r["code_hash"] for r in connection.execute("SELECT code_hash FROM admin_recovery_codes")]
    assert row["pending_seed_ciphertext"] is None
    assert decrypt_seed(row["seed_ciphertext"], ADMIN_TOTP_BINDING) == second
    assert len(stored_hashes) == 10
    assert admin_client.get("/api/auth/status").json()["totp_enrolled"] is True


def test_confirm_and_setup_state_conflicts(admin_client, frozen_time):
    missing = admin_client.post("/api/auth/totp/confirm", json={"code": "123456"})
    assert missing.status_code == 409
    assert missing.json()["detail"] == "TOTP_SETUP_REQUIRED"
    assert admin_client.post("/api/auth/recovery-codes/regenerate", json={"code": "123456"}).json()["detail"] == "TOTP_NOT_ENROLLED"
    enroll(admin_client, frozen_time.now)
    again = admin_client.post("/api/auth/totp/setup")
    assert again.status_code == 409
    assert again.json()["detail"] == "TOTP_ALREADY_ENROLLED"


# ---- login with second factor -------------------------------------------------------------


def test_login_requires_code_without_consuming_attempts(admin_client, frozen_time):
    secret, _ = enroll(admin_client, frozen_time.now)
    outsider = visitor()
    for _ in range(12):
        response = login(outsider, password="definitely wrong")
        assert response.status_code == 400
        assert response.json()["detail"] == "TOTP_CODE_REQUIRED"
    assert login(outsider, code="   ").json()["detail"] == "TOTP_CODE_REQUIRED"
    assert admin_failure_window.count() == 0

    frozen_time.now += 30
    good = code_for(secret, frozen_time.now)
    wrong_password = login(outsider, password="definitely wrong", code=good)
    assert wrong_password.status_code == 401
    assert wrong_password.json()["detail"] == "INVALID_CREDENTIALS"
    wrong_factor = login(outsider, code=wrong_code(secret, frozen_time.now))
    assert wrong_factor.status_code == 401
    assert wrong_factor.json()["detail"] == "INVALID_CREDENTIALS"
    # The step was not burned by the wrong-password attempt.
    success = login(outsider, code=good)
    assert success.status_code == 200, success.text
    assert outsider.cookies.get("authtotp_session")
    reasons = [(row["action"], row["result"], row["reason"]) for row in audit_rows()]
    assert ("admin.login", "denied", "invalid_password") in reasons
    assert ("admin.login", "denied", "invalid_second_factor") in reasons
    assert ("admin.login", "success", "totp") in reasons


def test_totp_step_cannot_be_replayed(admin_client, frozen_time):
    secret, _ = enroll(admin_client, frozen_time.now)
    outsider = visitor()
    # The code used to confirm enrollment is already spent.
    assert login(outsider, code=code_for(secret, frozen_time.now)).status_code == 401

    frozen_time.now += 30
    fresh = code_for(secret, frozen_time.now)
    assert login(outsider, code=fresh).status_code == 200
    replay = login(visitor("198.51.100.44"), code=fresh)
    assert replay.status_code == 401
    assert replay.json()["detail"] == "INVALID_CREDENTIALS"

    frozen_time.now += 30
    assert login(outsider, code=fresh).status_code == 401  # older step after a newer one
    assert login(outsider, code=code_for(secret, frozen_time.now)).status_code == 200


def test_recovery_codes_are_single_use(admin_client, frozen_time):
    _, codes = enroll(admin_client, frozen_time.now)
    outsider = visitor()
    assert login(outsider, code=codes[0]).status_code == 200
    reused = login(outsider, code=codes[0])
    assert reused.status_code == 401
    assert reused.json()["detail"] == "INVALID_CREDENTIALS"
    # Case and hyphen are normalised.
    assert login(outsider, code=codes[1].replace("-", "").lower()).status_code == 200
    # A wrong password never burns a recovery code.
    assert login(outsider, password="definitely wrong", code=codes[2]).status_code == 401
    assert login(outsider, code=codes[2]).status_code == 200
    with database() as connection:
        used = connection.execute(
            "SELECT COUNT(*) FROM admin_recovery_codes WHERE used_at IS NOT NULL"
        ).fetchone()[0]
    assert used == 3
    assert ("admin.login", "success", "recovery_code") in [
        (row["action"], row["result"], row["reason"]) for row in audit_rows()
    ]


def test_secrets_never_reach_database_or_audit_in_plaintext(admin_client, frozen_time):
    secret, codes = enroll(admin_client, frozen_time.now)
    frozen_time.now += 30
    used_totp = code_for(secret, frozen_time.now)
    assert login(visitor(), code=used_totp).status_code == 200
    assert login(visitor(), code=codes[0]).status_code == 200
    assert login(visitor(), code=codes[0]).status_code == 401
    regenerated = admin_client.post("/api/auth/recovery-codes/regenerate", json={"code": codes[1]}).json()
    new_codes = regenerated["recovery_codes"]

    raw_db = raw_database_bytes()
    for value in [secret, *codes, *new_codes, *(code.replace("-", "") for code in codes + new_codes)]:
        assert value.encode("ascii") not in raw_db, value
    rows = audit_rows()
    text_columns = " ".join(
        str(row[column]) for row in rows for column in ("actor_id", "action", "entry_id", "reason", "source")
    )
    for value in [secret, used_totp, *codes, *new_codes]:
        assert value not in text_columns
    actions = {(row["action"], row["result"]) for row in rows}
    assert {
        ("admin.totp.setup", "success"),
        ("admin.totp.confirm", "success"),
        ("admin.login", "success"),
        ("admin.login", "denied"),
        ("admin.recovery_codes.regenerate", "success"),
    } <= actions


def test_regenerate_invalidates_previous_codes(admin_client, frozen_time):
    secret, old_codes = enroll(admin_client, frozen_time.now)
    rejected = admin_client.post(
        "/api/auth/recovery-codes/regenerate", json={"code": wrong_code(secret, frozen_time.now)}
    )
    assert rejected.status_code == 400
    assert rejected.json()["detail"] == "INVALID_TOTP_CODE"
    frozen_time.now += 30
    response = admin_client.post(
        "/api/auth/recovery-codes/regenerate", json={"code": code_for(secret, frozen_time.now)}
    )
    assert response.status_code == 200
    new_codes = response.json()["recovery_codes"]
    assert len(new_codes) == 10 and not set(new_codes) & set(old_codes)
    assert login(visitor(), code=old_codes[5]).status_code == 401
    assert login(visitor(), code=new_codes[5]).status_code == 200


def test_disable_requires_password_and_code(admin_client, frozen_time):
    secret, codes = enroll(admin_client, frozen_time.now)
    frozen_time.now += 30
    good = code_for(secret, frozen_time.now)
    wrong_password = admin_client.post("/api/auth/totp/disable", json={"password": "nope nope nope", "code": good})
    assert wrong_password.status_code == 400
    assert wrong_password.json()["detail"] == "INVALID_CREDENTIALS"
    wrong_factor = admin_client.post(
        "/api/auth/totp/disable", json={"password": PASSWORD, "code": wrong_code(secret, frozen_time.now)}
    )
    assert wrong_factor.status_code == 400
    assert wrong_factor.json()["detail"] == "INVALID_CREDENTIALS"
    assert admin_client.get("/api/auth/status").json()["totp_enrolled"] is True

    disabled = admin_client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": good})
    assert disabled.status_code == 200
    assert disabled.json() == {"ok": True}
    assert admin_client.get("/api/auth/status").json()["totp_enrolled"] is False
    with database() as connection:
        assert connection.execute("SELECT COUNT(*) FROM admin_totp").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM admin_recovery_codes").fetchone()[0] == 0
    # Back to password-only login; old recovery codes are gone.
    assert login(visitor()).status_code == 200
    assert ("admin.totp.disable", "success", "totp") in [
        (row["action"], row["result"], row["reason"]) for row in audit_rows()
    ]
    assert admin_client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": codes[0]}).json()["detail"] == "TOTP_NOT_ENROLLED"


# ---- AUTHTOTP_REQUIRE_ADMIN_TOTP ----------------------------------------------------------


def test_required_totp_allows_only_loopback_until_enrolled(admin_client, frozen_time, monkeypatch):
    require_totp(monkeypatch)
    remote = login(visitor("203.0.113.10"))
    assert remote.status_code == 403
    assert remote.json()["detail"] == "ADMIN_TOTP_NOT_ENROLLED"
    # Forged XFF from an untrusted peer does not make it loopback.
    spoofed = login(visitor("203.0.113.10"), headers={"X-Forwarded-For": "127.0.0.1"})
    assert spoofed.status_code == 403
    assert login(visitor("127.0.0.1")).status_code == 200
    assert login(visitor("::1")).status_code == 200
    # Wrong password from loopback is still a normal credential failure.
    assert login(visitor("127.0.0.1"), password="definitely wrong").status_code == 401

    # Behind a trusted local proxy the real public client is used, not the proxy's loopback.
    require_totp(monkeypatch, trusted_proxies=("127.0.0.1",))
    proxied = login(visitor("127.0.0.1"), headers={"X-Forwarded-For": "127.0.0.1, 198.51.100.7"})
    assert proxied.status_code == 403
    assert login(visitor("127.0.0.1")).status_code == 200  # SSH tunnel: no XFF

    secret, _ = enroll(admin_client, frozen_time.now)
    frozen_time.now += 30
    after = login(visitor("203.0.113.10"), code=code_for(secret, frozen_time.now))
    assert after.status_code == 200
    denied_sources = [
        row["source"] for row in audit_rows() if row["reason"] == "admin_totp_not_enrolled"
    ]
    assert denied_sources == ["203.0.113.10", "203.0.113.10", "198.51.100.7"]


# ---- global failure cap -------------------------------------------------------------------


def test_global_failure_cap_locks_all_sources(client, monkeypatch):
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    clock = FakeTime(10_000.0)
    monkeypatch.setattr(admin_failure_window, "clock", clock.time)

    def fail(ip: str) -> int:
        return login(visitor(ip), password="definitely wrong").status_code

    sources = [f"198.51.100.{n}" for n in range(1, 5)]
    plan = [sources[0]] * 8 + [sources[1]] * 8 + [sources[2]] * 8 + [sources[3]] * 5
    assert [fail(ip) for ip in plan] == [401] * 29
    assert admin_failure_window.count() == 29
    assert login(visitor("203.0.113.1")).status_code == 200  # 29 < 30: not locked yet

    clock.now += 600
    assert fail("203.0.113.2") == 401  # 30th failure inside the hour
    locked = login(visitor("203.0.113.3"))
    assert locked.status_code == 429
    assert locked.json()["detail"] == "LOGIN_LOCKED"
    assert int(locked.headers["Retry-After"]) == 3000
    # Loopback (local console / SSH tunnel) is exempt from the global lock.
    assert login(visitor("127.0.0.1")).status_code == 200
    assert login(visitor("::1")).status_code == 200
    # Second-factor management endpoints share the cap.
    assert client.post("/api/auth/totp/confirm", json={"code": "123456"}, headers={"X-CSRF-Token": client.cookies.get("authtotp_csrf")}).status_code == 429

    clock.now += 3000  # the oldest failures leave the 1 h window
    assert login(visitor("203.0.113.4")).status_code == 200


def test_loopback_failures_skip_global_cap_but_keep_per_source_limit(client, monkeypatch):
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    local = visitor("127.0.0.1")
    assert [login(local, password="definitely wrong").status_code for _ in range(8)] == [401] * 8
    assert admin_failure_window.count() == 0
    limited = login(local)
    assert limited.status_code == 429
    assert limited.json()["detail"] == "RATE_LIMITED"

    # Lock the global window, then a loopback failure is neither blocked nor counted.
    for _ in range(30):
        admin_failure_window.record()
    assert login(visitor("203.0.113.70")).json()["detail"] == "LOGIN_LOCKED"
    other_local = visitor("::1")
    assert login(other_local, password="definitely wrong").status_code == 401
    assert admin_failure_window.count() == 30
    assert login(other_local).status_code == 200
    # Session second-factor endpoints follow the same exemption.
    other_local.headers.update({"X-CSRF-Token": other_local.cookies.get("authtotp_csrf")})
    response = other_local.post("/api/auth/recovery-codes/regenerate", json={"code": "123456"})
    assert response.status_code == 409
    assert response.json()["detail"] == "TOTP_NOT_ENROLLED"
    remote_session = client.post(
        "/api/auth/recovery-codes/regenerate",
        json={"code": "123456"},
        headers={"X-CSRF-Token": client.cookies.get("authtotp_csrf")},
    )
    assert remote_session.status_code == 429


# ---- bootstrap gate -----------------------------------------------------------------------


def test_bootstrap_open_to_any_source_when_flag_off(client):
    assert login(visitor()).json()["detail"] == "BOOTSTRAP_REQUIRED"
    response = visitor("203.0.113.80").post("/api/auth/bootstrap", json={"password": PASSWORD})
    assert response.status_code == 200


def test_bootstrap_local_only_when_totp_required(client, monkeypatch):
    require_totp(monkeypatch)
    remote = visitor("203.0.113.80").post("/api/auth/bootstrap", json={"password": PASSWORD})
    assert remote.status_code == 403
    assert remote.json()["detail"] == "BOOTSTRAP_LOCAL_ONLY"
    spoofed = visitor("203.0.113.80").post(
        "/api/auth/bootstrap", json={"password": PASSWORD}, headers={"X-Forwarded-For": "127.0.0.1"}
    )
    assert spoofed.json()["detail"] == "BOOTSTRAP_LOCAL_ONLY"
    require_totp(monkeypatch, trusted_proxies=("127.0.0.1",))
    proxied = visitor("127.0.0.1").post(
        "/api/auth/bootstrap", json={"password": PASSWORD}, headers={"X-Forwarded-For": "198.51.100.9"}
    )
    assert proxied.json()["detail"] == "BOOTSTRAP_LOCAL_ONLY"
    assert client.get("/api/auth/status").json()["bootstrapped"] is False

    tunnel = visitor("127.0.0.1").post("/api/auth/bootstrap", json={"password": PASSWORD})
    assert tunnel.status_code == 200
    assert client.get("/api/auth/status").json()["bootstrapped"] is True
    # Remote sources keep getting 403 (not 409) so they learn nothing new.
    assert visitor("203.0.113.80").post("/api/auth/bootstrap", json={"password": PASSWORD}).json()["detail"] == "BOOTSTRAP_LOCAL_ONLY"


def test_bootstrap_denial_is_audited_without_password_and_rate_limited(client, monkeypatch):
    require_totp(monkeypatch, trusted_proxies=("127.0.0.1",))
    marker_password = "Unique-Bootstrap-Marker-7Q4"
    remote = visitor("203.0.113.81")
    statuses = [
        remote.post("/api/auth/bootstrap", json={"password": marker_password}).status_code for _ in range(6)
    ]
    # Five denials inside the per-source limit are audited; the sixth is throttled and not written.
    assert statuses == [403] * 5 + [429]
    proxied = visitor("127.0.0.1").post(
        "/api/auth/bootstrap", json={"password": marker_password}, headers={"X-Forwarded-For": "198.51.100.10"}
    )
    assert proxied.json()["detail"] == "BOOTSTRAP_LOCAL_ONLY"

    denied = [
        (row["action"], row["result"], row["reason"], row["source"])
        for row in audit_rows()
        if row["reason"] == "bootstrap_local_only"
    ]
    assert denied == [("admin.bootstrap", "denied", "bootstrap_local_only", "203.0.113.81")] * 5 + [
        ("admin.bootstrap", "denied", "bootstrap_local_only", "198.51.100.10")
    ]
    assert marker_password.encode("utf-8") not in raw_database_bytes()
    assert client.get("/api/auth/status").json()["bootstrapped"] is False


# ---- other sessions are revoked after second-factor changes --------------------------------


def _session_alive(via: TestClient) -> bool:
    return via.get("/api/entries").status_code == 200


def test_second_factor_changes_revoke_other_sessions(admin_client, frozen_time):
    # confirm: a password-only session opened before enrollment is dropped.
    before = visitor("203.0.113.90")
    assert login(before).status_code == 200 and _session_alive(before)
    secret, codes = enroll(admin_client, frozen_time.now)
    assert not _session_alive(before)
    assert before.get("/api/entries").json()["detail"] == "ADMIN_SESSION_REQUIRED"
    assert _session_alive(admin_client)

    # regenerate: a failed attempt revokes nothing; a successful one drops other sessions.
    second = visitor("203.0.113.91")
    assert login(second, code=codes[0]).status_code == 200 and _session_alive(second)
    failed = admin_client.post(
        "/api/auth/recovery-codes/regenerate", json={"code": wrong_code(secret, frozen_time.now)}
    )
    assert failed.status_code == 400
    assert _session_alive(second)
    regenerated = admin_client.post("/api/auth/recovery-codes/regenerate", json={"code": codes[1]})
    assert regenerated.status_code == 200
    assert not _session_alive(second)
    assert _session_alive(admin_client)

    # disable: same rule.
    new_codes = regenerated.json()["recovery_codes"]
    third = visitor("203.0.113.92")
    assert login(third, code=new_codes[0]).status_code == 200 and _session_alive(third)
    disabled = admin_client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": new_codes[1]})
    assert disabled.status_code == 200
    assert not _session_alive(third)
    assert _session_alive(admin_client)
    with database() as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
