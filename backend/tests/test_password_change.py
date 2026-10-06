"""POST /api/auth/password: admin password change with optional TOTP / recovery code."""

from __future__ import annotations

import time

import pyotp
import pytest
from fastapi.testclient import TestClient

from backend.app import admin_totp as admin_totp_module
from backend.app.config import settings
from backend.app.db import database
from backend.app.main import app
from backend.app.security import admin_failure_window


PASSWORD = "correct horse battery staple"
NEW_PASSWORD = "Brand-New-Admin-Passphrase-42"


class FakeTime:
    def __init__(self, now: float) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


@pytest.fixture()
def frozen_time(monkeypatch):
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


def login(via: TestClient, password: str = PASSWORD, code: str | None = None):
    body = {"password": password}
    if code is not None:
        body["code"] = code
    return via.post("/api/auth/login", json=body)


def logged_in(ip: str, password: str = PASSWORD, code: str | None = None) -> TestClient:
    session = visitor(ip)
    assert login(session, password, code).status_code == 200
    session.headers.update({"X-CSRF-Token": session.cookies.get("authtotp_csrf")})
    return session


def enroll(admin_client, now: float) -> tuple[str, list[str]]:
    secret = admin_client.post("/api/auth/totp/setup").json()["secret_base32"]
    confirm = admin_client.post("/api/auth/totp/confirm", json={"code": code_for(secret, now)})
    assert confirm.status_code == 200, confirm.text
    return secret, confirm.json()["recovery_codes"]


def change(via: TestClient, current: str = PASSWORD, new: str = NEW_PASSWORD, code: str | None = None):
    body = {"current_password": current, "new_password": new}
    if code is not None:
        body["code"] = code
    return via.post("/api/auth/password", json=body)


def session_alive(via: TestClient) -> bool:
    return via.get("/api/entries").status_code == 200


def raw_database_bytes() -> bytes:
    path = settings.database_path
    parts = [path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")]
    return b"".join(part.read_bytes() for part in parts if part.exists())


def password_events() -> list[tuple]:
    with database() as connection:
        return [
            (row["result"], row["reason"], row["source"])
            for row in connection.execute(
                "SELECT * FROM audit_events WHERE action = 'admin.password.change' ORDER BY id"
            )
        ]


def test_requires_session_and_csrf(client):
    assert change(client).status_code == 401
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    response = change(client)
    assert response.status_code == 403
    assert response.json()["detail"] == "CSRF_CHECK_FAILED"


def test_change_without_totp_updates_hash_and_revokes_other_sessions(admin_client):
    other = logged_in("203.0.113.20")
    assert session_alive(other)
    response = change(admin_client)
    assert response.status_code == 200
    assert response.json() == {"ok": True}

    assert not session_alive(other)
    assert other.get("/api/entries").json()["detail"] == "ADMIN_SESSION_REQUIRED"
    assert session_alive(admin_client)
    old = login(visitor("203.0.113.21"))
    assert old.status_code == 401
    assert login(visitor("203.0.113.21"), password=NEW_PASSWORD).status_code == 200
    assert password_events() == [("success", None, "testclient")]


def test_new_password_rules_match_bootstrap(admin_client):
    for bad in ("short-pw", "x" * 257):
        response = change(admin_client, new=bad)
        assert response.status_code == 422
        errors = response.json()["detail"]
        assert errors[0]["loc"] == ["body", "new_password"]
        assert errors[0]["type"] in {"string_too_short", "string_too_long"}
    # Same constraint object as first-time setup.
    from backend.app.schemas import BootstrapRequest, PasswordChangeRequest

    assert (
        BootstrapRequest.model_fields["password"].metadata
        == PasswordChangeRequest.model_fields["new_password"].metadata
    )
    assert login(visitor()).status_code == 200  # nothing changed


def test_unchanged_password_is_rejected_without_consuming_anything(admin_client, frozen_time):
    secret, codes = enroll(admin_client, frozen_time.now)
    response = change(admin_client, new=PASSWORD, code=codes[0])
    assert response.status_code == 400
    assert response.json()["detail"] == "PASSWORD_UNCHANGED"
    assert admin_failure_window.count() == 0
    assert password_events() == []
    # The recovery code offered with the rejected request is still usable.
    assert change(admin_client, code=codes[0]).status_code == 200


def test_wrong_current_password_counts_as_failure(admin_client):
    response = change(admin_client, current="definitely wrong")
    assert response.status_code == 400
    assert response.json()["detail"] == "INVALID_CREDENTIALS"
    assert admin_failure_window.count() == 1
    assert session_alive(admin_client)  # 400, not 401: the session is untouched
    assert login(visitor()).status_code == 200
    assert password_events() == [("denied", "invalid_password", "testclient")]


def test_totp_required_when_enrolled_and_code_not_counted(admin_client, frozen_time):
    secret, _ = enroll(admin_client, frozen_time.now)
    for _ in range(12):
        response = change(admin_client, current="definitely wrong")
        assert response.status_code == 400
        assert response.json()["detail"] == "TOTP_CODE_REQUIRED"
    assert change(admin_client, code="  ").json()["detail"] == "TOTP_CODE_REQUIRED"
    assert admin_failure_window.count() == 0

    frozen_time.now += 30
    good = code_for(secret, frozen_time.now)
    wrong_factor = change(admin_client, code=wrong_code(secret, frozen_time.now))
    assert wrong_factor.status_code == 400
    assert wrong_factor.json()["detail"] == "INVALID_CREDENTIALS"
    wrong_password = change(admin_client, current="definitely wrong", code=good)
    assert wrong_password.json()["detail"] == "INVALID_CREDENTIALS"
    # The TOTP step was not burned by the wrong-password attempt.
    assert change(admin_client, code=good).status_code == 200
    assert [event[:2] for event in password_events()] == [
        ("denied", "invalid_second_factor"),
        ("denied", "invalid_password"),
        ("success", "totp"),
    ]
    assert admin_failure_window.count() == 2


def test_totp_step_cannot_be_replayed(admin_client, frozen_time):
    secret, _ = enroll(admin_client, frozen_time.now)
    frozen_time.now += 30
    used = code_for(secret, frozen_time.now)
    assert change(admin_client, code=used).status_code == 200
    replay = change(admin_client, current=NEW_PASSWORD, new="Another-Long-Passphrase-77", code=used)
    assert replay.status_code == 400
    assert replay.json()["detail"] == "INVALID_CREDENTIALS"
    # The same step is also spent for login.
    assert login(visitor(), password=NEW_PASSWORD, code=used).status_code == 401


def test_recovery_code_is_consumed(admin_client, frozen_time):
    _, codes = enroll(admin_client, frozen_time.now)
    assert change(admin_client, code=codes[3]).status_code == 200
    with database() as connection:
        used = connection.execute(
            "SELECT COUNT(*) FROM admin_recovery_codes WHERE used_at IS NOT NULL"
        ).fetchone()[0]
    assert used == 1
    assert login(visitor(), password=NEW_PASSWORD, code=codes[3]).status_code == 401
    assert login(visitor(), password=NEW_PASSWORD, code=codes[4]).status_code == 200
    assert password_events()[-1][:2] == ("success", "recovery_code")


def test_per_source_rate_limit_and_global_lock(admin_client):
    statuses = [change(admin_client, current="definitely wrong").status_code for _ in range(9)]
    assert statuses == [400] * 8 + [429]
    assert change(admin_client).json()["detail"] == "RATE_LIMITED"

    for _ in range(30):
        admin_failure_window.record()
    remote = logged_in("127.0.0.1")  # loopback logs in despite the lock
    remote_session = TestClient(app, client=("203.0.113.30", 50000), cookies=remote.cookies)
    remote_session.headers.update({"X-CSRF-Token": remote.cookies.get("authtotp_csrf")})
    locked = change(remote_session)
    assert locked.status_code == 429
    assert locked.json()["detail"] == "LOGIN_LOCKED"
    assert "Retry-After" in locked.headers
    # Loopback is exempt from the global lock and its failures are not counted.
    local_failure = change(remote, current="definitely wrong")
    assert local_failure.status_code == 400
    assert admin_failure_window.count() == 30 + 8
    assert change(remote).status_code == 200


def test_no_plaintext_in_database_or_audit(admin_client, frozen_time):
    secret, codes = enroll(admin_client, frozen_time.now)
    frozen_time.now += 30
    used_totp = code_for(secret, frozen_time.now)
    assert change(admin_client, code=wrong_code(secret, frozen_time.now)).status_code == 400
    assert change(admin_client, code=used_totp).status_code == 200
    assert change(admin_client, current=NEW_PASSWORD, new="Third-Admin-Passphrase-99", code=codes[0]).status_code == 200

    raw = raw_database_bytes()
    for value in (PASSWORD, NEW_PASSWORD, "Third-Admin-Passphrase-99", secret, codes[0], codes[0].replace("-", "")):
        assert value.encode("utf-8") not in raw, value
    with database() as connection:
        text = " ".join(
            str(row[column])
            for row in connection.execute("SELECT * FROM audit_events")
            for column in ("actor_id", "action", "entry_id", "reason", "source")
        )
    for value in (PASSWORD, NEW_PASSWORD, "Third-Admin-Passphrase-99", secret, used_totp, codes[0]):
        assert value not in text
