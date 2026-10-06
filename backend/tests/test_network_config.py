"""Item 1 (Host / Origin / Cookie config) and item 2 (trusted-proxy source IP)."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import textwrap
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import main as main_module
from backend.app.config import DEFAULT_ALLOWED_HOSTS, Settings
from backend.app.db import database
from backend.app.main import app
from backend.app.network import is_loopback, normalize_origin, resolve_client_ip


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PASSWORD = "correct horse battery staple"
NEW_VARS = [
    "AUTHTOTP_ALLOWED_HOSTS",
    "AUTHTOTP_ALLOWED_ORIGINS",
    "AUTHTOTP_COOKIE_SECURE",
    "AUTHTOTP_TRUSTED_PROXIES",
    "AUTHTOTP_REQUIRE_ADMIN_TOTP",
]


def _cookie_attributes(set_cookie: str) -> set[str]:
    return {part.strip().lower() for part in set_cookie.split(";")[1:]}


def _audit_sources() -> list[str]:
    with database() as connection:
        return [row["source"] for row in connection.execute("SELECT source FROM audit_events ORDER BY id")]


# ---- item 1: configuration parsing -------------------------------------------------------


def test_defaults_keep_local_behaviour(monkeypatch):
    for name in NEW_VARS:
        monkeypatch.delenv(name, raising=False)
    loaded = Settings.load()
    assert loaded.allowed_hosts == ("127.0.0.1", "localhost", "testserver") == DEFAULT_ALLOWED_HOSTS
    assert loaded.allowed_origins == ()
    assert loaded.cookie_secure is False
    assert loaded.trusted_proxies == ()
    assert loaded.require_admin_totp is False


def test_env_values_are_parsed_and_normalized(monkeypatch):
    monkeypatch.setenv("AUTHTOTP_ALLOWED_HOSTS", " Vault.example.com ,127.0.0.1,, ")
    monkeypatch.setenv(
        "AUTHTOTP_ALLOWED_ORIGINS", "https://Vault.example.com/, https://vault.example.com:443"
    )
    monkeypatch.setenv("AUTHTOTP_COOKIE_SECURE", "true")
    monkeypatch.setenv("AUTHTOTP_TRUSTED_PROXIES", "127.0.0.1, ::1")
    monkeypatch.setenv("AUTHTOTP_REQUIRE_ADMIN_TOTP", "1")
    loaded = Settings.load()
    assert loaded.allowed_hosts == ("vault.example.com", "127.0.0.1")
    assert loaded.allowed_origins == ("https://vault.example.com",)
    assert loaded.cookie_secure is True
    assert loaded.trusted_proxies == ("127.0.0.1", "::1")
    assert loaded.require_admin_totp is True


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("AUTHTOTP_ALLOWED_ORIGINS", "vault.example.com"),
        ("AUTHTOTP_ALLOWED_ORIGINS", "https://vault.example.com/admin"),
        ("AUTHTOTP_TRUSTED_PROXIES", "nginx"),
        ("AUTHTOTP_COOKIE_SECURE", "maybe"),
        ("AUTHTOTP_REQUIRE_ADMIN_TOTP", "enabled"),
    ],
)
def test_invalid_env_values_fail_fast(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError):
        Settings.load()


def test_normalize_origin():
    assert normalize_origin("https://VAULT.example.com") == "https://vault.example.com"
    assert normalize_origin("http://127.0.0.1:18473") == "http://127.0.0.1:18473"
    assert normalize_origin("null") is None
    assert normalize_origin("https://user@vault.example.com") is None
    assert normalize_origin("ftp://vault.example.com") is None


# ---- item 1: behaviour on the real app -----------------------------------------------------


def test_default_cookies_are_not_secure(client):
    response = client.post("/api/auth/bootstrap", json={"password": PASSWORD})
    assert response.status_code == 200
    cookies = response.headers.get_list("set-cookie")
    assert len(cookies) == 2
    for cookie in cookies:
        attributes = _cookie_attributes(cookie)
        assert "secure" not in attributes
        assert "samesite=strict" in attributes


def test_cookie_secure_flag_marks_session_and_csrf(client, monkeypatch):
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, cookie_secure=True))
    response = client.post("/api/auth/bootstrap", json={"password": PASSWORD})
    assert response.status_code == 200
    cookies = response.headers.get_list("set-cookie")
    assert {cookie.split("=", 1)[0] for cookie in cookies} == {"authtotp_session", "authtotp_csrf"}
    for cookie in cookies:
        assert "secure" in _cookie_attributes(cookie)


def test_origin_rules_default_and_configured(client, monkeypatch):
    local = TestClient(app, base_url="http://127.0.0.1:18473")
    same_origin = local.post("/api/auth/logout", headers={"Origin": "http://127.0.0.1:18473"})
    assert same_origin.status_code == 401  # passed origin check, failed on missing session
    public = local.post("/api/auth/logout", headers={"Origin": "https://vault.example.com"})
    assert public.status_code == 403
    assert public.json()["error"]["code"] == "ORIGIN_REJECTED"

    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, allowed_origins=("https://vault.example.com",)),
    )
    accepted = local.post("/api/auth/logout", headers={"Origin": "https://vault.example.com"})
    assert accepted.status_code == 401
    assert local.post("/api/auth/logout", headers={"Origin": "http://127.0.0.1:18473"}).status_code == 401
    for rejected_origin in ("https://evil.example", "http://vault.example.com", "null", "http://[::1"):
        rejected = local.post("/api/auth/logout", headers={"Origin": rejected_origin})
        assert rejected.status_code == 403, rejected_origin
        assert rejected.json()["error"]["code"] == "ORIGIN_REJECTED"


def test_public_profile_end_to_end_in_fresh_process(tmp_path):
    """Env → Settings → TrustedHost / Origin / Secure cookie / XFF, exactly as a server start would."""
    script = textwrap.dedent(
        """
        import json
        from fastapi.testclient import TestClient
        from backend.app.db import database
        from backend.app.main import app

        out = {}
        with TestClient(app, base_url="https://vault.example.com", client=("127.0.0.1", 40000)) as c:
            evil_host = TestClient(app, base_url="https://evil.example", client=("127.0.0.1", 40001))
            out["evil_host"] = evil_host.get("/health").status_code
            out["localhost_host"] = TestClient(app, base_url="http://127.0.0.1:18473").get("/health").status_code
            out["proxied_bootstrap"] = c.post(
                "/api/auth/bootstrap",
                json={"password": "correct horse battery staple"},
                headers={"Origin": "https://vault.example.com", "X-Forwarded-For": "198.51.100.7"},
            ).json()
            boot = c.post(
                "/api/auth/bootstrap",
                json={"password": "correct horse battery staple"},
                headers={"Origin": "https://vault.example.com"},
            )
            out["bootstrap"] = boot.status_code
            out["set_cookie"] = boot.headers.get_list("set-cookie")
            out["status"] = c.get("/api/auth/status").json()
            out["evil_origin"] = c.post("/api/auth/logout", headers={"Origin": "https://evil.example"}).status_code
            out["http_origin"] = c.post("/api/auth/logout", headers={"Origin": "http://vault.example.com"}).status_code
            proxied = TestClient(app, base_url="https://vault.example.com", client=("127.0.0.1", 40002))
            out["proxied_login"] = proxied.post(
                "/api/auth/login",
                json={"password": "correct horse battery staple"},
                headers={"Origin": "https://vault.example.com", "X-Forwarded-For": "127.0.0.1, 198.51.100.8"},
            ).json()
            tunnel = TestClient(app, base_url="http://127.0.0.1:18473", client=("127.0.0.1", 40003))
            out["tunnel_login"] = tunnel.post(
                "/api/auth/login",
                json={"password": "correct horse battery staple"},
                headers={"Origin": "http://127.0.0.1:18473"},
            ).status_code
            with database() as connection:
                out["audit"] = [
                    [row["action"], row["result"], row["reason"], row["source"]]
                    for row in connection.execute("SELECT * FROM audit_events ORDER BY id")
                ]
        print(json.dumps(out))
        """
    )
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("AUTHTOTP_") and key != "CREDENTIALS_DIRECTORY"
    }
    env.update(
        AUTHTOTP_DATA_DIR=str(tmp_path),
        AUTHTOTP_DATABASE_PATH=str(tmp_path / "public.db"),
        AUTHTOTP_FRONTEND_DIST=str(tmp_path / "dist"),
        AUTHTOTP_MASTER_KEY=base64.urlsafe_b64encode(b"P" * 32).decode("ascii"),
        AUTHTOTP_ALLOWED_HOSTS="vault.example.com,127.0.0.1,localhost",
        AUTHTOTP_ALLOWED_ORIGINS="https://vault.example.com",
        AUTHTOTP_COOKIE_SECURE="1",
        AUTHTOTP_TRUSTED_PROXIES="127.0.0.1,::1",
        AUTHTOTP_REQUIRE_ADMIN_TOTP="true",
        PYTHONPATH=str(PROJECT_ROOT),
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["evil_host"] == 400
    assert out["localhost_host"] == 200
    # With REQUIRE_ADMIN_TOTP the first admin password can only be set from loopback.
    assert out["proxied_bootstrap"] == {"detail": "BOOTSTRAP_LOCAL_ONLY"}
    assert out["bootstrap"] == 200
    assert len(out["set_cookie"]) == 2
    assert all("secure" in _cookie_attributes(cookie) for cookie in out["set_cookie"])
    assert out["status"]["totp_required"] is True
    assert out["status"]["totp_enrolled"] is False
    assert out["evil_origin"] == 403
    assert out["http_origin"] == 403
    # Through the proxy the real (non-loopback) client is seen, so the unenrolled gate holds.
    assert out["proxied_login"] == {"detail": "ADMIN_TOTP_NOT_ENROLLED"}
    # SSH-tunnel style: direct loopback peer, no XFF → first-time binding login allowed.
    assert out["tunnel_login"] == 200
    assert out["audit"][0] == ["admin.bootstrap", "denied", "bootstrap_local_only", "198.51.100.7"]
    assert out["audit"][1] == ["admin.bootstrap", "success", None, "127.0.0.1"]
    assert ["admin.login", "denied", "admin_totp_not_enrolled", "198.51.100.8"] in out["audit"]
    assert ["admin.login", "success", None, "127.0.0.1"] in out["audit"]


def test_required_totp_without_trusted_proxies_refuses_to_load(monkeypatch):
    for name in NEW_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AUTHTOTP_REQUIRE_ADMIN_TOTP", "1")
    with pytest.raises(ValueError) as excinfo:
        Settings.load()
    message = str(excinfo.value)
    assert "AUTHTOTP_REQUIRE_ADMIN_TOTP" in message
    assert "AUTHTOTP_TRUSTED_PROXIES" in message
    assert "回环" in message
    monkeypatch.setenv("AUTHTOTP_TRUSTED_PROXIES", "127.0.0.1")
    assert Settings.load().require_admin_totp is True
    monkeypatch.setenv("AUTHTOTP_REQUIRE_ADMIN_TOTP", "0")
    monkeypatch.delenv("AUTHTOTP_TRUSTED_PROXIES")
    assert Settings.load().trusted_proxies == ()


def test_service_process_refuses_to_start_without_trusted_proxies(tmp_path):
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("AUTHTOTP_") and key != "CREDENTIALS_DIRECTORY"
    }
    env.update(
        AUTHTOTP_DATA_DIR=str(tmp_path),
        AUTHTOTP_DATABASE_PATH=str(tmp_path / "refuse.db"),
        AUTHTOTP_FRONTEND_DIST=str(tmp_path / "dist"),
        AUTHTOTP_MASTER_KEY=base64.urlsafe_b64encode(b"P" * 32).decode("ascii"),
        AUTHTOTP_REQUIRE_ADMIN_TOTP="1",
        PYTHONPATH=str(PROJECT_ROOT),
    )
    result = subprocess.run(
        [sys.executable, "-c", "import backend.app.main"],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode != 0
    assert "AUTHTOTP_REQUIRE_ADMIN_TOTP" in result.stderr
    assert "AUTHTOTP_TRUSTED_PROXIES" in result.stderr
    assert not (tmp_path / "refuse.db").exists()


# ---- item 2: trusted-proxy client IP ------------------------------------------------------


def test_resolve_client_ip_rules():
    trusted = ("127.0.0.1", "10.0.0.2")
    # No trusted proxies configured: XFF is never consulted.
    assert resolve_client_ip("203.0.113.9", ["127.0.0.1"], ()) == "203.0.113.9"
    # Direct peer not trusted: forged XFF ignored.
    assert resolve_client_ip("198.51.100.20", ["127.0.0.1"], trusted) == "198.51.100.20"
    # Trusted peer: right-most non-trusted hop wins; attacker-supplied left part is ignored.
    assert resolve_client_ip("127.0.0.1", ["127.0.0.1, 198.51.100.7"], trusted) == "198.51.100.7"
    assert resolve_client_ip("127.0.0.1", ["6.6.6.6, 198.51.100.7, 10.0.0.2"], trusted) == "198.51.100.7"
    assert resolve_client_ip("127.0.0.1", ["6.6.6.6", "198.51.100.7"], trusted) == "198.51.100.7"
    # Trusted peer without XFF (SSH tunnel) keeps the peer.
    assert resolve_client_ip("127.0.0.1", [], trusted) == "127.0.0.1"
    # IPv4-mapped peer is recognised as the same trusted proxy.
    assert resolve_client_ip("::ffff:127.0.0.1", ["198.51.100.7"], trusted) == "198.51.100.7"
    # Garbage hop never becomes a usable (or loopback) source.
    assert resolve_client_ip("127.0.0.1", ["not-an-ip"], trusted) == "unknown"
    assert resolve_client_ip(None, [], trusted) == "unknown"
    assert is_loopback("127.0.0.1") and is_loopback("::1") and is_loopback("::ffff:127.0.0.1")
    assert not is_loopback("unknown") and not is_loopback("testclient") and not is_loopback("198.51.100.7")


def test_forged_xff_is_ignored_without_trusted_proxy(client):
    attacker = TestClient(app, client=("203.0.113.9", 50000))
    response = attacker.post(
        "/api/auth/bootstrap",
        json={"password": PASSWORD},
        headers={"X-Forwarded-For": "127.0.0.1"},
    )
    assert response.status_code == 200
    assert _audit_sources() == ["203.0.113.9"]


def test_trusted_proxy_source_feeds_audit_and_login_rate_limit(client, monkeypatch):
    assert client.post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    monkeypatch.setattr(
        main_module, "settings", replace(main_module.settings, trusted_proxies=("127.0.0.1",))
    )
    proxy = TestClient(app, client=("127.0.0.1", 50000))
    direct = TestClient(app, client=("203.0.113.9", 50000))

    def wrong_login(via: TestClient, xff: str | None) -> int:
        headers = {"X-Forwarded-For": xff} if xff else {}
        return via.post("/api/auth/login", json={"password": "wrong password"}, headers=headers).status_code

    # Eight failures from one real client behind the proxy exhaust only that client's bucket.
    assert [wrong_login(proxy, "127.0.0.1, 198.51.100.7") for _ in range(8)] == [401] * 8
    assert wrong_login(proxy, "198.51.100.7") == 429
    assert wrong_login(proxy, "198.51.100.8") == 401
    # A non-proxy peer cannot borrow another client's bucket by forging XFF.
    assert wrong_login(direct, "198.51.100.8") == 401

    sources = _audit_sources()
    assert sources[1:9] == ["198.51.100.7"] * 8
    assert sources[9:] == ["198.51.100.8", "203.0.113.9"]
