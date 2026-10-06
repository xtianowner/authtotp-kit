from __future__ import annotations

import base64
import os
import tempfile
from pathlib import Path


TEST_ROOT = Path(tempfile.mkdtemp(prefix="authtotp-tests-"))
os.environ["AUTHTOTP_DATA_DIR"] = str(TEST_ROOT)
os.environ["AUTHTOTP_DATABASE_PATH"] = str(TEST_ROOT / "test.db")
os.environ["AUTHTOTP_FRONTEND_DIST"] = str(TEST_ROOT / "dist")
os.environ["AUTHTOTP_MASTER_KEY"] = base64.urlsafe_b64encode(b"T" * 32).decode("ascii")
os.environ["AUTHTOTP_RATE_LIMIT_PER_MINUTE"] = "100"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.app.db import database  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.security import admin_failure_window, rate_limiter  # noqa: E402


@pytest.fixture()
def client():
    rate_limiter.clear()
    admin_failure_window.clear()
    with TestClient(app) as test_client:
        with database() as connection:
            for table in [
                "audit_events",
                "caller_entries",
                "callers",
                "entries",
                "sessions",
                "admin_auth",
                "admin_totp",
                "admin_recovery_codes",
            ]:
                connection.execute(f"DELETE FROM {table}")
        yield test_client


def bootstrap(client: TestClient) -> str:
    response = client.post("/api/auth/bootstrap", json={"password": "correct horse battery staple"})
    assert response.status_code == 200, response.text
    csrf = client.cookies.get("authtotp_csrf")
    assert csrf
    return csrf


@pytest.fixture()
def admin_client(client: TestClient):
    csrf = bootstrap(client)
    client.headers.update({"X-CSRF-Token": csrf})
    return client
