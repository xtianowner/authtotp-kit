"""Per-token lifetime chosen at creation (expires_in_hours) and the GET /api/meta default."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from backend.app import main as main_module
from backend.app import security
from backend.app.db import database, initialize_database
from backend.app.security import NEVER_EXPIRES


URI = "otpauth://totp/GitHub%3Ademo-lifetime?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"


def _entry(client) -> dict:
    response = client.post("/api/entries", json={"otpauth_uri": URI})
    assert response.status_code == 201, response.text
    return response.json()


def _create(client, entry_id: str, name: str, **extra) -> dict:
    response = client.post(
        "/api/callers",
        json={"name": name, "purpose": "lifetime test", "allowed_entry_ids": [entry_id], **extra},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _stored_expiry(caller_id: str) -> str:
    with database() as connection:
        return connection.execute("SELECT expires_at FROM callers WHERE id = ?", (caller_id,)).fetchone()[0]


def _assert_expires_in(caller: dict, hours: int) -> None:
    expires_at = datetime.fromisoformat(caller["expires_at"])
    assert expires_at.utcoffset() == timedelta(0)
    assert abs(expires_at - (datetime.now(UTC) + timedelta(hours=hours))) < timedelta(seconds=30)
    assert _stored_expiry(caller["id"]) == caller["expires_at"]


def _code(client, entry_id: str, token: str):
    return client.post(f"/v1/totp/{entry_id}/code", headers={"Authorization": f"Bearer {token}"})


def _use_default_hours(monkeypatch, hours: int) -> None:
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, caller_token_hours=hours))


def test_expires_in_hours_sets_real_expiry(admin_client):
    entry = _entry(admin_client)
    one_hour = _create(admin_client, entry["id"], "one-hour", expires_in_hours=1)
    one_year = _create(admin_client, entry["id"], "one-year", expires_in_hours=8760)
    assert one_hour["token"].startswith("ttb_live_")
    assert one_hour["status"] == "active"
    _assert_expires_in(one_hour, 1)
    _assert_expires_in(one_year, 8760)


def test_expires_in_hours_zero_never_expires(admin_client, monkeypatch):
    _use_default_hours(monkeypatch, 720)  # explicit 0 must win over a non-zero server default
    entry = _entry(admin_client)
    caller = _create(admin_client, entry["id"], "forever", expires_in_hours=0)
    assert caller["expires_at"] is None
    assert _stored_expiry(caller["id"]) == NEVER_EXPIRES


@pytest.mark.parametrize("body_extra", [{}, {"expires_in_hours": None}], ids=["omitted", "null"])
def test_missing_expires_in_hours_uses_server_default(admin_client, monkeypatch, body_extra):
    entry = _entry(admin_client)
    assert main_module.settings.caller_token_hours == 0  # test configuration = existing behaviour
    unchanged = _create(admin_client, entry["id"], "default-zero", **body_extra)
    assert unchanged["expires_at"] is None
    assert _stored_expiry(unchanged["id"]) == NEVER_EXPIRES

    _use_default_hours(monkeypatch, 720)
    thirty_days = _create(admin_client, entry["id"], "default-720", **body_extra)
    _assert_expires_in(thirty_days, 720)
    explicit = _create(admin_client, entry["id"], "explicit-1", expires_in_hours=1)
    _assert_expires_in(explicit, 1)


@pytest.mark.parametrize("value", [-1, 8761, 100000, 1.5, 1.0, "1", True, "abc", [], {}])
def test_invalid_expires_in_hours_is_422(admin_client, value):
    entry = _entry(admin_client)
    response = admin_client.post(
        "/api/callers",
        json={"name": "bad", "purpose": "lifetime test", "allowed_entry_ids": [entry["id"]], "expires_in_hours": value},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"][:2] == ["body", "expires_in_hours"]
    with database() as connection:
        assert connection.execute("SELECT COUNT(*) FROM callers").fetchone()[0] == 0


def test_create_audit_records_hours_without_token(admin_client, monkeypatch):
    entry = _entry(admin_client)
    hourly = _create(admin_client, entry["id"], "audited-hourly", expires_in_hours=24)
    _use_default_hours(monkeypatch, 720)
    defaulted = _create(admin_client, entry["id"], "audited-default")
    with database() as connection:
        rows = connection.execute(
            "SELECT * FROM audit_events WHERE action = 'caller.create' ORDER BY id"
        ).fetchall()
    assert [row["reason"] for row in rows] == [
        "allowlist_count=1 expires_in_hours=24 expiry_from=request",
        "allowlist_count=1 expires_in_hours=720 expiry_from=default",
    ]
    for row in rows:
        stored = " ".join(str(value) for value in tuple(row))
        for caller in (hourly, defaulted):
            assert caller["token"] not in stored
            assert caller["token"][-6:] not in stored


def test_meta_returns_default_hours_and_requires_admin(client, monkeypatch):
    denied = client.get("/api/meta")
    assert denied.status_code == 401
    assert denied.json() == {"detail": "ADMIN_SESSION_REQUIRED"}

    setup = client.post("/api/auth/bootstrap", json={"password": "correct horse battery staple"})
    assert setup.status_code == 200, setup.text
    response = client.get("/api/meta")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"caller_token_default_hours": 0}

    _use_default_hours(monkeypatch, 720)
    assert client.get("/api/meta").json() == {"caller_token_default_hours": 720}


def test_hourly_token_is_rejected_after_expiry_but_permanent_is_not(admin_client, monkeypatch):
    entry = _entry(admin_client)
    hourly = _create(admin_client, entry["id"], "hourly", expires_in_hours=1)
    permanent = _create(admin_client, entry["id"], "permanent", expires_in_hours=0)
    deadline = datetime.fromisoformat(hourly["expires_at"])

    assert _code(admin_client, entry["id"], hourly["token"]).status_code == 200

    # Freeze the clock the expiry check reads (security.utc_now) at chosen instants.
    monkeypatch.setattr(security, "utc_now", lambda: deadline - timedelta(seconds=1))
    assert _code(admin_client, entry["id"], hourly["token"]).status_code == 200

    for frozen in (deadline, deadline + timedelta(seconds=1), deadline + timedelta(days=400)):
        monkeypatch.setattr(security, "utc_now", lambda frozen=frozen: frozen)
        denied = _code(admin_client, entry["id"], hourly["token"])
        assert denied.status_code == 401, frozen
        assert denied.json()["error"]["code"] == "UNAUTHENTICATED"
        assert _code(admin_client, entry["id"], permanent["token"]).status_code == 200

    with database() as connection:
        reasons = [
            row[0]
            for row in connection.execute(
                "SELECT reason FROM audit_events WHERE action = 'code.read' AND result = 'denied'"
            ).fetchall()
        ]
    assert reasons == ["expired_caller"] * 3
    statuses = {item["name"]: item["status"] for item in admin_client.get("/api/callers").json()}
    assert statuses == {"hourly": "expired", "permanent": "active"}


def test_hourly_token_keeps_its_expiry_across_restart_with_zero_default(admin_client):
    assert main_module.settings.caller_token_hours == 0  # the configuration the one-time migration targets
    entry = _entry(admin_client)
    hourly = _create(admin_client, entry["id"], "hourly-restart", expires_in_hours=1)
    original = hourly["expires_at"]
    assert original is not None

    initialize_database()  # service restart
    initialize_database()

    assert _stored_expiry(hourly["id"]) == original
    listed = {item["id"]: item for item in admin_client.get("/api/callers").json()}
    assert listed[hourly["id"]]["expires_at"] == original
    assert listed[hourly["id"]]["status"] == "active"
