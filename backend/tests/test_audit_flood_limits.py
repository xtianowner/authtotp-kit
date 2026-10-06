"""Anonymous /v1 traffic cannot grow the audit table without bound or smuggle long request ids into it."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from backend.app.db import database
from backend.app.main import V1_SOURCE_LIMIT, V1_SOURCE_WINDOW_SECONDS, app


UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
BOGUS = {"Authorization": "Bearer not-a-real-token"}
URI = "otpauth://totp/GitHub%3Ademo-limit?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"


def create_entry(client: TestClient) -> dict:
    response = client.post("/api/entries", json={"otpauth_uri": URI, "purpose": "automation"})
    assert response.status_code == 201, response.text
    return response.json()


def _audit_count() -> int:
    with database() as connection:
        return connection.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0]


def _audit_request_ids() -> list[str]:
    with database() as connection:
        return [row[0] for row in connection.execute("SELECT request_id FROM audit_events ORDER BY id")]


def test_v1_source_limit_stops_audit_growth(client):
    attacker = TestClient(app, client=("203.0.113.50", 50000))
    statuses = [attacker.post("/v1/totp/x/code", headers=BOGUS).status_code for _ in range(V1_SOURCE_LIMIT)]
    assert statuses == [401] * V1_SOURCE_LIMIT
    assert _audit_count() == V1_SOURCE_LIMIT

    for _ in range(240):
        limited = attacker.post("/v1/totp/x/code", headers=BOGUS)
        assert limited.status_code == 429
        assert limited.headers["Retry-After"] == str(V1_SOURCE_WINDOW_SECONDS)
        assert limited.json()["error"]["code"] == "RATE_LIMITED"
    assert _audit_count() == V1_SOURCE_LIMIT

    # The bucket is per source: another client is unaffected.
    other = TestClient(app, client=("203.0.113.51", 50000))
    assert other.post("/v1/totp/x/code", headers=BOGUS).status_code == 401
    assert _audit_count() == V1_SOURCE_LIMIT + 1


def test_v1_source_limit_runs_before_token_check(admin_client):
    entry = create_entry(admin_client)
    caller = admin_client.post(
        "/api/callers",
        json={"name": "limit", "purpose": "source limit", "allowed_entry_ids": [entry["id"]]},
    ).json()
    source = TestClient(app, client=("203.0.113.60", 50000))
    for _ in range(V1_SOURCE_LIMIT):
        assert source.post("/v1/totp/x/code").status_code == 401  # no token: counted, not audited
    before = _audit_count()
    valid = source.post(f"/v1/totp/{entry['id']}/code", headers={"Authorization": f"Bearer {caller['token']}"})
    assert valid.status_code == 429
    assert "code" not in valid.json()
    assert _audit_count() == before


@pytest.mark.parametrize("request_id", ["flow-test", "a.B_9-z", "x" * 64])
def test_well_formed_request_id_is_kept(client, request_id):
    response = client.post("/v1/totp/x/code", headers={**BOGUS, "X-Request-ID": request_id})
    assert response.status_code == 401
    assert response.headers["X-Request-ID"] == request_id
    assert response.json()["request_id"] == request_id
    assert _audit_request_ids() == [request_id]


@pytest.mark.parametrize("request_id", ["x" * 65, "y" * 8000, "has space", "a/b", "semi;colon", "quote\"d"])
def test_malformed_request_id_is_replaced_before_storage(client, request_id):
    response = client.post("/v1/totp/x/code", headers={**BOGUS, "X-Request-ID": request_id})
    assert response.status_code == 401
    generated = response.headers["X-Request-ID"]
    assert UUID4.fullmatch(generated)
    assert response.json()["request_id"] == generated
    assert _audit_request_ids() == [generated]
