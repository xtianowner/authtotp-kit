"""Startup with CALLER_TOKEN_HOURS=0 extends only callers that are still valid."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from backend.app.config import settings
from backend.app.db import CALLER_NEVER_EXPIRE_MIGRATED, database, initialize_database
from backend.app.security import NEVER_EXPIRES, caller_is_expired


URI = "otpauth://totp/GitHub%3Ademo-expiry?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"


def _new_caller(client, entry_id: str, name: str) -> dict:
    response = client.post(
        "/api/callers", json={"name": name, "purpose": "expiry migration", "allowed_entry_ids": [entry_id]}
    )
    assert response.status_code == 201, response.text
    return response.json()


def _stored_expiry(caller_id: str) -> str:
    with database() as connection:
        return connection.execute("SELECT expires_at FROM callers WHERE id = ?", (caller_id,)).fetchone()[0]


def test_expired_caller_stays_expired_after_restart(admin_client):
    assert settings.caller_token_hours == 0  # the default configuration
    entry = admin_client.post("/api/entries", json={"otpauth_uri": URI}).json()
    expired = _new_caller(admin_client, entry["id"], "expired")
    still_valid = _new_caller(admin_client, entry["id"], "still-valid")
    past = (datetime.now(UTC) - timedelta(days=3)).isoformat()
    # Same instant, different offset spelling: must also stay expired.
    past_offset = (datetime.now(UTC) - timedelta(hours=1)).astimezone(timezone(timedelta(hours=8))).isoformat()
    future = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    offset_caller = _new_caller(admin_client, entry["id"], "expired-offset")
    with database() as connection:
        connection.execute("UPDATE callers SET expires_at = ? WHERE id = ?", (past, expired["id"]))
        connection.execute("UPDATE callers SET expires_at = ? WHERE id = ?", (past_offset, offset_caller["id"]))
        connection.execute("UPDATE callers SET expires_at = ? WHERE id = ?", (future, still_valid["id"]))
        # Simulate the first start on a database that has never run the one-time migration.
        connection.execute("DELETE FROM meta WHERE key = ?", (CALLER_NEVER_EXPIRE_MIGRATED,))

    initialize_database()  # what the first service start runs

    assert _stored_expiry(expired["id"]) == past
    assert _stored_expiry(offset_caller["id"]) == past_offset
    assert caller_is_expired(_stored_expiry(expired["id"]))
    assert caller_is_expired(_stored_expiry(offset_caller["id"]))
    assert _stored_expiry(still_valid["id"]) == NEVER_EXPIRES

    denied = admin_client.post(
        f"/v1/totp/{entry['id']}/code", headers={"Authorization": f"Bearer {expired['token']}"}
    )
    assert denied.status_code == 401
    with database() as connection:
        reason = connection.execute(
            "SELECT reason FROM audit_events WHERE action = 'code.read' ORDER BY id DESC LIMIT 1"
        ).fetchone()[0]
    assert reason == "expired_caller"
    statuses = {item["name"]: item["status"] for item in admin_client.get("/api/callers").json()}
    assert statuses == {"expired": "expired", "expired-offset": "expired", "still-valid": "active"}
