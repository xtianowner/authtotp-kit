"""At most two Argon2 operations run at once; a request that cannot get a slot in time gets 429."""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager

import pyotp
import pytest
from fastapi.testclient import TestClient

from backend.app import admin_totp as admin_totp_module
from backend.app import security
from backend.app.db import database
from backend.app.main import app
from backend.app.security import ARGON2_SLOTS, admin_failure_window, hash_password, verify_password


PASSWORD = "correct horse battery staple"
NEW_PASSWORD = "a different long passphrase"


@pytest.fixture()
def short_wait(monkeypatch):
    monkeypatch.setattr(security, "ARGON2_WAIT_SECONDS", 0.2)


@contextmanager
def all_slots_taken():
    """Occupy every Argon2 slot, as a burst of in-flight password checks would."""
    for _ in range(ARGON2_SLOTS):
        assert security._argon2_slots.acquire(timeout=1)
    try:
        yield
    finally:
        for _ in range(ARGON2_SLOTS):
            security._argon2_slots.release()


def _slots_all_free() -> bool:
    taken = [security._argon2_slots.acquire(blocking=False) for _ in range(ARGON2_SLOTS)]
    for ok in taken:
        if ok:
            security._argon2_slots.release()
    return all(taken)


def _audit_count() -> int:
    with database() as connection:
        return connection.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]


def _assert_busy(response) -> None:
    assert response.status_code == 429
    assert response.json() == {"detail": "RATE_LIMITED"}
    assert response.headers["Retry-After"] == "10"


class SlowHasher:
    """Stands in for argon2's PasswordHasher and records how many calls overlap."""

    def __init__(self) -> None:
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()

    def _run(self) -> None:
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
        time.sleep(0.15)
        with self.lock:
            self.active -= 1

    def hash(self, password: str) -> str:
        self._run()
        return "hashed"

    def verify(self, password_hash: str, password: str) -> bool:
        self._run()
        return True


def test_argon2_runs_at_most_two_at_once(monkeypatch):
    fake = SlowHasher()
    monkeypatch.setattr(security, "password_hasher", fake)
    results: list[object] = []
    calls = [lambda: verify_password("h", "p"), lambda: hash_password("p")] * 4
    threads = [threading.Thread(target=lambda call=call: results.append(call())) for call in calls]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    assert len(results) == 8  # everyone waited for a slot instead of failing
    assert fake.peak == ARGON2_SLOTS == 2
    assert _slots_all_free()


def test_busy_login_is_429_not_audited_not_a_failure_but_uses_source_budget(client, short_wait):
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    audited = _audit_count()
    attacker = TestClient(app, client=("203.0.113.70", 50000))
    with all_slots_taken():
        for _ in range(8):
            _assert_busy(attacker.post("/api/auth/login", json={"password": "wrong password"}))
    assert _audit_count() == audited
    assert admin_failure_window.count() == 0
    # The 8 busy attempts used up this source's login budget: next one hits the per-source limit.
    limited = attacker.post("/api/auth/login", json={"password": PASSWORD})
    assert limited.status_code == 429 and "Retry-After" not in limited.headers
    # Other sources are unaffected once the slots are free again.
    assert TestClient(app, client=("203.0.113.71", 50000)).post(
        "/api/auth/login", json={"password": PASSWORD}
    ).status_code == 200
    assert _slots_all_free()


def test_busy_bootstrap_writes_nothing(client, short_wait):
    with all_slots_taken():
        _assert_busy(client.post("/api/auth/bootstrap", json={"password": PASSWORD}))
    with database() as connection:
        assert connection.execute("SELECT 1 FROM admin_auth").fetchone() is None
    assert _audit_count() == 0
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200


def test_busy_password_change_keeps_old_password(admin_client, short_wait):
    with all_slots_taken():
        _assert_busy(
            admin_client.post(
                "/api/auth/password", json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}
            )
        )
    fresh = TestClient(app)
    assert fresh.post("/api/auth/login", json={"password": PASSWORD}).status_code == 200
    assert fresh.post("/api/auth/login", json={"password": NEW_PASSWORD}).status_code == 401


class FrozenClock:
    def __init__(self, now: float) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


def test_busy_totp_disable_burns_no_code(admin_client, short_wait, monkeypatch):
    clock = FrozenClock((int(time.time()) // 30) * 30 + 1)
    monkeypatch.setattr(admin_totp_module, "time", clock)
    secret = admin_client.post("/api/auth/totp/setup").json()["secret_base32"]
    confirm = admin_client.post("/api/auth/totp/confirm", json={"code": pyotp.TOTP(secret).at(clock.now)})
    assert confirm.status_code == 200, confirm.text
    clock.now += 30  # next step, so the code below has not been used yet
    code = pyotp.TOTP(secret).at(clock.now)
    with all_slots_taken():
        _assert_busy(admin_client.post("/api/auth/totp/disable", json={"password": PASSWORD, "code": code}))
    assert admin_client.get("/api/auth/status").json()["totp_enrolled"] is True
    # The busy attempt consumed nothing: the same one-time code still disables it.
    assert admin_client.post(
        "/api/auth/totp/disable", json={"password": PASSWORD, "code": code}
    ).status_code == 200
    assert _slots_all_free()
