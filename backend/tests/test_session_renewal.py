"""Sliding renewal of admin sessions."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from backend.app import main as main_module
from backend.app.config import Settings
from backend.app.main import _renewal_threshold
from backend.app.db import database
from backend.app.security import hash_secret


PASSWORD = "correct horse battery staple"
URI = "otpauth://totp/GitHub%3Ademo-test?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"


def set_remaining(delta: timedelta, token: str | None = None) -> None:
    value = (datetime.now(UTC) + delta).isoformat()
    with database() as connection:
        if token:
            connection.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (value, hash_secret(token)))
        else:
            connection.execute("UPDATE sessions SET expires_at = ?", (value,))


def stored_expiry(token: str) -> datetime | None:
    with database() as connection:
        row = connection.execute(
            "SELECT expires_at FROM sessions WHERE token_hash = ?", (hash_secret(token),)
        ).fetchone()
    return datetime.fromisoformat(row["expires_at"]) if row else None


def set_cookies(response) -> dict[str, str]:
    """name -> full Set-Cookie header for the two session cookies."""
    found = {}
    for header in response.headers.get_list("set-cookie"):
        name = header.split("=", 1)[0]
        if name in {"authtotp_session", "authtotp_csrf"}:
            found[name] = header
    return found


def cookie_value(header: str) -> str:
    return header.split("=", 1)[1].split(";", 1)[0]


def attributes(header: str) -> set[str]:
    return {part.strip().lower() for part in header.split(";")[1:]}


def test_renewal_threshold_rule():
    # > 48 h: renew once 24 h have passed since issue/renewal (remaining < H - 24 h).
    assert _renewal_threshold(2160) == timedelta(hours=2136)
    assert _renewal_threshold(720) == timedelta(hours=696)
    assert _renewal_threshold(49) == timedelta(hours=25)
    # <= 48 h: fall back to "less than half left" (H - 24 h would never/too-late renew).
    assert _renewal_threshold(48) == timedelta(hours=24)
    assert _renewal_threshold(24) == timedelta(hours=12)
    assert _renewal_threshold(12) == timedelta(hours=6)


def test_short_lifetime_more_than_half_left_is_not_renewed(admin_client):
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(hours=10))  # default 12 h -> half rule, threshold 6 h
    before = stored_expiry(token)
    response = admin_client.get("/api/entries")
    assert response.status_code == 200
    assert set_cookies(response) == {}
    assert stored_expiry(token) == before


def test_short_lifetime_less_than_half_left_is_renewed_with_same_values(admin_client):
    token = admin_client.cookies.get("authtotp_session")
    csrf = admin_client.cookies.get("authtotp_csrf")
    set_remaining(timedelta(hours=5))
    response = admin_client.get("/api/entries")
    assert response.status_code == 200
    cookies = set_cookies(response)
    assert set(cookies) == {"authtotp_session", "authtotp_csrf"}
    assert cookie_value(cookies["authtotp_session"]) == token
    assert cookie_value(cookies["authtotp_csrf"]) == csrf
    session_attrs = attributes(cookies["authtotp_session"])
    assert {"httponly", "samesite=strict", "path=/", "max-age=43200"} <= session_attrs
    csrf_attrs = attributes(cookies["authtotp_csrf"])
    assert {"samesite=strict", "path=/", "max-age=43200"} <= csrf_attrs and "httponly" not in csrf_attrs
    renewed = stored_expiry(token)
    assert abs((renewed - datetime.now(UTC)) - timedelta(hours=12)) < timedelta(seconds=30)

    # Double-submit CSRF still passes with the token the client already holds.
    created = admin_client.post("/api/entries", json={"otpauth_uri": URI, "purpose": "automation"})
    assert created.status_code == 201, created.text
    # Freshly renewed: the next request does not write again.
    assert set_cookies(admin_client.get("/api/entries")) == {}


def test_renewal_also_happens_on_error_responses(admin_client):
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(hours=1))
    response = admin_client.post("/api/callers", json={"name": ""})  # 422 from the handler layer
    assert response.status_code == 422
    assert "authtotp_session" in set_cookies(response)
    assert stored_expiry(token) - datetime.now(UTC) > timedelta(hours=11)


def test_expired_session_is_rejected_and_deleted(admin_client):
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(seconds=-1))
    response = admin_client.get("/api/entries")
    assert response.status_code == 401
    assert response.json()["detail"] == "ADMIN_SESSION_EXPIRED"
    assert set_cookies(response) == {}
    assert stored_expiry(token) is None
    assert admin_client.get("/api/entries").json()["detail"] == "ADMIN_SESSION_REQUIRED"


def test_logout_due_for_renewal_still_logs_out(admin_client):
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(hours=1))
    response = admin_client.post("/api/auth/logout")
    assert response.status_code == 200
    session_cookie = set_cookies(response)["authtotp_session"]
    assert cookie_value(session_cookie) in ('""', "")
    assert "max-age=0" in attributes(session_cookie)
    assert stored_expiry(token) is None


def test_password_change_keeps_semantics_when_renewing(admin_client):
    from fastapi.testclient import TestClient

    from backend.app.main import app

    other = TestClient(app, client=("203.0.113.40", 50000))
    assert other.post("/api/auth/login", json={"password": PASSWORD}).status_code == 200
    other_token = other.cookies.get("authtotp_session")
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(hours=1), token)
    response = admin_client.post(
        "/api/auth/password",
        json={"current_password": PASSWORD, "new_password": "Brand-New-Admin-Passphrase-42"},
    )
    assert response.status_code == 200
    assert "authtotp_session" in set_cookies(response)  # current session renewed
    assert stored_expiry(other_token) is None  # other session still revoked, not resurrected
    assert other.get("/api/entries").status_code == 401


def test_session_deleted_during_request_is_not_resurrected(admin_client, monkeypatch):
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(hours=1))

    def list_then_revoke(_=None):
        with database() as connection:
            connection.execute("DELETE FROM sessions")
        return []

    route = next(r for r in main_module.app.routes if getattr(r, "path", "") == "/api/entries" and "GET" in r.methods)
    monkeypatch.setattr(route.dependant, "call", list_then_revoke)
    response = admin_client.get("/api/entries")
    assert response.status_code == 200
    assert set_cookies(response) == {}
    assert stored_expiry(token) is None


def test_missing_csrf_cookie_renews_session_only(admin_client):
    token = admin_client.cookies.get("authtotp_session")
    csrf = admin_client.cookies.get("authtotp_csrf")
    admin_client.cookies.delete("authtotp_csrf")
    set_remaining(timedelta(hours=1))
    cookies = set_cookies(admin_client.get("/api/entries"))
    assert set(cookies) == {"authtotp_session"}
    assert cookie_value(cookies["authtotp_session"]) == token
    assert stored_expiry(token) - datetime.now(UTC) > timedelta(hours=11)
    # The CSRF value itself is unchanged server-side; mutations keep working with the header.
    assert admin_client.post("/api/entries", json={"otpauth_uri": URI}, headers={"X-CSRF-Token": csrf}).status_code == 201


def test_bearer_caller_requests_do_not_touch_admin_session(admin_client):
    entry = admin_client.post("/api/entries", json={"otpauth_uri": URI}).json()
    caller = admin_client.post(
        "/api/callers", json={"name": "bot", "purpose": "t", "allowed_entry_ids": [entry["id"]]}
    ).json()
    token = admin_client.cookies.get("authtotp_session")
    set_remaining(timedelta(hours=1))
    before = stored_expiry(token)
    response = admin_client.post(
        f"/v1/totp/{entry['id']}/code", headers={"Authorization": f"Bearer {caller['token']}"}
    )
    assert response.status_code == 200
    assert set_cookies(response) == {}
    assert stored_expiry(token) == before


def test_session_hours_2160(admin_client, monkeypatch):
    monkeypatch.setenv("AUTHTOTP_SESSION_HOURS", "2160")
    assert Settings.load().session_hours == 2160
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, session_hours=2160))

    from fastapi.testclient import TestClient

    from backend.app.main import app

    fresh = TestClient(app, client=("203.0.113.41", 50000))
    login = fresh.post("/api/auth/login", json={"password": PASSWORD})
    assert "max-age=7776000" in attributes(set_cookies(login)["authtotp_session"])
    token = fresh.cookies.get("authtotp_session")
    assert stored_expiry(token) - datetime.now(UTC) > timedelta(days=89, hours=23)

    # 23 h after issue: not renewed, nothing written.
    set_remaining(timedelta(hours=2160 - 23), token)
    before = stored_expiry(token)
    assert set_cookies(fresh.get("/api/entries")) == {}
    assert stored_expiry(token) == before
    # 25 h after issue: renewed back to the full 90 days.
    set_remaining(timedelta(hours=2160 - 25), token)
    renewed = set_cookies(fresh.get("/api/entries"))
    assert "max-age=7776000" in attributes(renewed["authtotp_session"])
    assert "max-age=7776000" in attributes(renewed["authtotp_csrf"])
    assert stored_expiry(token) - datetime.now(UTC) > timedelta(days=89, hours=23)
    # At most one renewal write per day: the very next request leaves it alone.
    after = stored_expiry(token)
    assert set_cookies(fresh.get("/api/entries")) == {}
    assert stored_expiry(token) == after
