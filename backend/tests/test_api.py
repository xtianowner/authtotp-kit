from __future__ import annotations

import sqlite3
import base64
from datetime import UTC, datetime, timedelta

from backend.app.config import settings
from backend.app.db import database
from backend.app.main import clock_monitor
from backend.app.security import NEVER_EXPIRES


URI = "otpauth://totp/GitHub%3Ademo-test?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"


def create_entry(client):
    response = client.post("/api/entries", json={"otpauth_uri": URI, "purpose": "automation"})
    assert response.status_code == 201, response.text
    payload = response.json()
    assert "secret" not in payload
    assert "seed" not in payload
    assert "seed_ciphertext" not in payload
    return payload


def test_requires_admin_session(client):
    response = client.get("/api/entries")
    assert response.status_code == 401


def test_requires_csrf_for_admin_mutation(client):
    response = client.post("/api/auth/bootstrap", json={"password": "correct horse battery staple"})
    assert response.status_code == 200
    response = client.post("/api/entries", json={"otpauth_uri": URI})
    assert response.status_code == 403
    assert response.json()["detail"] == "CSRF_CHECK_FAILED"


def test_complete_broker_flow_and_redaction(admin_client):
    entry = create_entry(admin_client)
    listed_entry = admin_client.get("/api/entries").json()[0]
    assert "secret" not in listed_entry
    assert "seed" not in listed_entry
    assert "seed_ciphertext" not in listed_entry
    duplicate = admin_client.post("/api/entries", json={"otpauth_uri": URI})
    assert duplicate.status_code == 409

    caller_response = admin_client.post(
        "/api/callers",
        json={"name": "test-runner", "purpose": "integration test", "allowed_entry_ids": [entry["id"]]},
    )
    assert caller_response.status_code == 201, caller_response.text
    caller = caller_response.json()
    token = caller["token"]
    assert token.startswith("ttb_live_")
    assert caller["expires_at"] is None

    code_response = admin_client.post(
        f"/v1/totp/{entry['id']}/code",
        headers={"Authorization": f"Bearer {token}", "X-Request-ID": "flow-test"},
    )
    assert code_response.status_code == 200, code_response.text
    payload = code_response.json()
    assert payload["code"].isdigit() and len(payload["code"]) == 6
    assert payload["request_id"] == "flow-test"
    assert payload["remaining_seconds"] > 0

    unauthorized = admin_client.post(
        f"/v1/totp/{entry['id']}/code", headers={"Authorization": "Bearer invalid"}
    )
    assert unauthorized.status_code == 401

    disable = admin_client.patch(f"/api/entries/{entry['id']}", json={"status": "disabled"})
    assert disable.status_code == 200
    disabled = admin_client.post(
        f"/v1/totp/{entry['id']}/code", headers={"Authorization": f"Bearer {token}"}
    )
    assert disabled.status_code == 409
    assert disabled.json()["error"]["code"] == "ENTRY_DISABLED"

    raw_db = settings.database_path.read_bytes()
    assert b"JBSWY3DPEHPK3PXP" not in raw_db
    assert token.encode("utf-8") not in raw_db
    assert payload["code"].encode("ascii") not in raw_db

    with sqlite3.connect(settings.database_path) as connection:
        audit_text = " ".join(str(value) for row in connection.execute("SELECT * FROM audit_events") for value in row)
    assert "JBSWY3DPEHPK3PXP" not in audit_text
    assert token not in audit_text
    assert payload["code"] not in audit_text


def test_allowlist_is_enforced(admin_client):
    first = create_entry(admin_client)
    second_response = admin_client.post(
        "/api/entries",
        json={"secret": "KRUGS4ZANFZSAYJA", "label": "Second", "issuer": "Test", "purpose": "automation"},
    )
    assert second_response.status_code == 201
    second = second_response.json()
    caller = admin_client.post(
        "/api/callers",
        json={"name": "limited", "purpose": "one entry", "allowed_entry_ids": [first["id"]]},
    ).json()
    denied = admin_client.post(
        f"/v1/totp/{second['id']}/code", headers={"Authorization": f"Bearer {caller['token']}"}
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "CALLER_NOT_ALLOWED"


def test_delete_requires_disabled_state(admin_client):
    entry = create_entry(admin_client)
    active_delete = admin_client.request("DELETE", f"/api/entries/{entry['id']}", json={"confirmation": "DELETE"})
    assert active_delete.status_code == 409
    admin_client.patch(f"/api/entries/{entry['id']}", json={"status": "disabled"})
    deleted = admin_client.request("DELETE", f"/api/entries/{entry['id']}", json={"confirmation": "DELETE"})
    assert deleted.status_code == 200
    assert admin_client.get("/api/entries").json() == []


def test_expired_caller_is_rejected_and_not_counted(admin_client):
    entry = create_entry(admin_client)
    caller = admin_client.post(
        "/api/callers",
        json={"name": "ephemeral", "purpose": "expiry test", "allowed_entry_ids": [entry["id"]]},
    ).json()
    assert caller["expires_at"] is None
    with database() as connection:
        connection.execute(
            "UPDATE callers SET expires_at = ? WHERE id = ?",
            ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), caller["id"]),
        )
    denied = admin_client.post(
        f"/v1/totp/{entry['id']}/code",
        headers={"Authorization": f"Bearer {caller['token']}"},
    )
    assert denied.status_code == 401
    listed = admin_client.get("/api/entries").json()
    assert listed[0]["caller_count"] == 0
    callers = admin_client.get("/api/callers").json()
    assert callers[0]["status"] == "expired"


def test_never_expire_migration_runs_only_on_first_start(admin_client):
    from backend.app.db import CALLER_NEVER_EXPIRE_MIGRATED, initialize_database

    def stored_expiry(caller_id: str) -> str:
        with database() as connection:
            return connection.execute(
                "SELECT expires_at FROM callers WHERE id = ?", (caller_id,)
            ).fetchone()["expires_at"]

    def migration_marker():
        with database() as connection:
            row = connection.execute(
                "SELECT value FROM meta WHERE key = ?", (CALLER_NEVER_EXPIRE_MIGRATED,)
            ).fetchone()
        return row["value"] if row else None

    entry = create_entry(admin_client)
    body = {"purpose": "migration test", "allowed_entry_ids": [entry["id"]]}
    existing = admin_client.post("/api/callers", json={"name": "pre-existing", **body}).json()
    in_one_hour = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    with database() as connection:
        # A database that has never run the migration: no marker, one still-valid finite caller.
        connection.execute("DELETE FROM meta WHERE key = ?", (CALLER_NEVER_EXPIRE_MIGRATED,))
        connection.execute("UPDATE callers SET expires_at = ? WHERE id = ?", (in_one_hour, existing["id"]))
    assert settings.caller_token_hours == 0

    initialize_database()  # first start: the migration runs once and leaves its marker
    assert stored_expiry(existing["id"]) == NEVER_EXPIRES
    listed = admin_client.get("/api/callers").json()
    assert next(item for item in listed if item["id"] == existing["id"])["expires_at"] is None
    assert migration_marker() == "1"

    later = admin_client.post("/api/callers", json={"name": "created-later", **body}).json()
    with database() as connection:
        connection.execute("UPDATE callers SET expires_at = ? WHERE id = ?", (in_one_hour, later["id"]))

    initialize_database()  # every later start skips it
    assert stored_expiry(later["id"]) == in_one_hour
    assert stored_expiry(existing["id"]) == NEVER_EXPIRES
    assert migration_marker() == "1"


def test_clock_jump_is_resynced_before_code_generation(admin_client, monkeypatch):
    entry = create_entry(admin_client)
    caller = admin_client.post(
        "/api/callers",
        json={"name": "clock-check", "purpose": "clock test", "allowed_entry_ids": [entry["id"]]},
    ).json()
    checks = iter([False, True])
    resync_calls = []
    monkeypatch.setattr(clock_monitor, "healthy", lambda: next(checks))
    monkeypatch.setattr(clock_monitor, "resync", lambda: resync_calls.append(True))
    response = admin_client.post(
        f"/v1/totp/{entry['id']}/code",
        headers={"Authorization": f"Bearer {caller['token']}"},
    )
    assert response.status_code == 200, response.text
    assert len(resync_calls) == 1


def test_clock_unhealthy_after_resync_refuses_code(admin_client, monkeypatch):
    entry = create_entry(admin_client)
    caller = admin_client.post(
        "/api/callers",
        json={"name": "clock-check", "purpose": "clock test", "allowed_entry_ids": [entry["id"]]},
    ).json()
    monkeypatch.setattr(clock_monitor, "healthy", lambda: False)
    admin_response = admin_client.post(f"/api/entries/{entry['id']}/code", json={})
    assert admin_response.status_code == 503
    assert admin_response.json()["detail"] == "CLOCK_UNHEALTHY"
    response = admin_client.post(
        f"/v1/totp/{entry['id']}/code",
        headers={"Authorization": f"Bearer {caller['token']}"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "CLOCK_UNHEALTHY"


def test_mismatched_master_key_returns_stable_error(admin_client, monkeypatch):
    entry = create_entry(admin_client)
    monkeypatch.setenv(
        "AUTHTOTP_MASTER_KEY",
        base64.urlsafe_b64encode(b"R" * 32).decode("ascii"),
    )
    response = admin_client.post(f"/api/entries/{entry['id']}/code", json={})
    assert response.status_code == 503
    assert response.json()["detail"] == "KEY_UNAVAILABLE"


def test_admin_code_includes_next_window_code_with_one_audit_row(admin_client):
    import pyotp

    entry = create_entry(admin_client)
    response = admin_client.post(f"/api/entries/{entry['id']}/code", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    upcoming = body["next"]
    assert set(upcoming) == {"code", "valid_from", "valid_until"}
    assert upcoming["valid_from"] == body["valid_until"]
    starts_at = int(datetime.fromisoformat(upcoming["valid_from"]).timestamp())
    ends_at = int(datetime.fromisoformat(upcoming["valid_until"]).timestamp())
    assert ends_at - starts_at == body["period_seconds"]
    assert upcoming["code"] == pyotp.TOTP("JBSWY3DPEHPK3PXP").at(starts_at)
    with database() as connection:
        reads = connection.execute(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'code.read' AND entry_id = ?", (entry["id"],)
        ).fetchone()[0]
    assert reads == 1


def test_broker_code_never_includes_next_window_code(admin_client):
    entry = create_entry(admin_client)
    caller = admin_client.post(
        "/api/callers",
        json={"name": "next-code-check", "purpose": "broker must not leak next code", "allowed_entry_ids": [entry["id"]]},
    ).json()
    response = admin_client.post(
        f"/v1/totp/{entry['id']}/code", headers={"Authorization": f"Bearer {caller['token']}"}
    )
    assert response.status_code == 200, response.text
    assert "next" not in response.json()
