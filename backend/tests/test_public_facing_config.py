"""Internet-facing configs must close first-time setup; loopback peers with forwarding headers are not local."""

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
from backend.app.config import Settings
from backend.app.db import database
from backend.app.main import app


PROJECT_ROOT = Path(__file__).resolve().parents[2]
# The deploy template lives at deploy/ in the public kit and at kit/public-root/deploy/ in the private source.
ENV_EXAMPLE_CANDIDATES = (
    PROJECT_ROOT / "deploy" / "authtotp.env.example",
    PROJECT_ROOT / "kit" / "public-root" / "deploy" / "authtotp.env.example",
)
ENV_EXAMPLE = next((p for p in ENV_EXAMPLE_CANDIDATES if p.exists()), ENV_EXAMPLE_CANDIDATES[0])
PASSWORD = "correct horse battery staple"
CONFIG_VARS = [
    "AUTHTOTP_ALLOWED_HOSTS",
    "AUTHTOTP_ALLOWED_ORIGINS",
    "AUTHTOTP_COOKIE_SECURE",
    "AUTHTOTP_TRUSTED_PROXIES",
    "AUTHTOTP_REQUIRE_ADMIN_TOTP",
    "AUTHTOTP_ALLOW_REMOTE_SETUP",
]


def _example_settings() -> dict[str, str]:
    """The AUTHTOTP_* network settings exactly as shipped in deploy/authtotp.env.example."""
    if not ENV_EXAMPLE.exists():
        pytest.skip("deploy/authtotp.env.example is not part of a backend-only copy")
    values: dict[str, str] = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in CONFIG_VARS:
            values[key] = value
    return values


@pytest.fixture()
def clean_env(monkeypatch):
    for name in CONFIG_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _load_with(monkeypatch, values: dict[str, str]) -> Settings:
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return Settings.load()


def _subprocess_env(tmp_path: Path, extra: dict[str, str]) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("AUTHTOTP_") and key != "CREDENTIALS_DIRECTORY"
    }
    env.update(
        AUTHTOTP_DATA_DIR=str(tmp_path),
        AUTHTOTP_DATABASE_PATH=str(tmp_path / "vault.db"),
        AUTHTOTP_FRONTEND_DIST=str(tmp_path / "dist"),
        PYTHONPATH=str(PROJECT_ROOT),
    )
    env.update(extra)
    return env


def _run(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


START_AND_PROBE = textwrap.dedent(
    """
    import json
    from fastapi.testclient import TestClient
    from backend.app.main import app
    with TestClient(app, base_url="http://127.0.0.1:18473") as c:
        print(json.dumps({"health": c.get("/health").status_code, "status": c.get("/api/auth/status").json()}))
    """
)


# ---- Fix A: which configurations may start ------------------------------------------------


def test_example_is_public_facing_and_complete():
    example = _example_settings()
    assert example["AUTHTOTP_REQUIRE_ADMIN_TOTP"] == "1"
    assert example["AUTHTOTP_COOKIE_SECURE"] == "1"
    assert example["AUTHTOTP_TRUSTED_PROXIES"]
    assert "AUTHTOTP_ALLOW_REMOTE_SETUP" not in example


def test_local_default_and_deploy_example_load(clean_env):
    local = Settings.load()
    assert local.require_admin_totp is False and local.allow_remote_setup is False
    deployed = _load_with(clean_env, _example_settings())
    assert deployed.require_admin_totp is True
    assert deployed.cookie_secure is True
    assert deployed.trusted_proxies == ("127.0.0.1",)


def test_local_only_hosts_do_not_count_as_public(clean_env):
    loaded = _load_with(clean_env, {"AUTHTOTP_ALLOWED_HOSTS": "127.0.0.1,localhost,::1,[::1],testserver"})
    assert loaded.require_admin_totp is False


@pytest.mark.parametrize("cookie_secure", ["1", "0"])
def test_remote_setup_escape_hatch_waives_totp_and_secure_cookie(clean_env, cookie_secure):
    loaded = _load_with(
        clean_env,
        {
            "AUTHTOTP_ALLOWED_HOSTS": "192.168.1.10,127.0.0.1",
            "AUTHTOTP_COOKIE_SECURE": cookie_secure,
            "AUTHTOTP_ALLOW_REMOTE_SETUP": "1",
        },
    )
    assert loaded.allow_remote_setup is True
    assert loaded.require_admin_totp is False
    assert loaded.cookie_secure is (cookie_secure == "1")
    assert loaded.trusted_proxies == ()


def test_plain_http_intranet_process_starts_and_sets_up(tmp_path):
    """Escape hatch end to end: a LAN client over plain HTTP sets the first password, cookies not Secure."""
    script = textwrap.dedent(
        """
        import json
        from fastapi.testclient import TestClient
        from backend.app.main import app
        with TestClient(app, base_url="http://192.168.1.10:18473", client=("192.168.1.23", 40000)) as c:
            boot = c.post("/api/auth/bootstrap", json={"password": "correct horse battery staple"},
                          headers={"Origin": "http://192.168.1.10:18473"})
            print(json.dumps({"bootstrap": boot.status_code, "set_cookie": boot.headers.get_list("set-cookie")}))
        """
    )
    env = _subprocess_env(
        tmp_path,
        {
            "AUTHTOTP_MASTER_KEY": base64.urlsafe_b64encode(b"I" * 32).decode("ascii"),
            "AUTHTOTP_ALLOWED_HOSTS": "192.168.1.10,127.0.0.1,localhost",
            "AUTHTOTP_ALLOWED_ORIGINS": "http://192.168.1.10:18473",
            "AUTHTOTP_ALLOW_REMOTE_SETUP": "1",
        },
    )
    result = _run(script, env)
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["bootstrap"] == 200
    assert len(out["set_cookie"]) == 2
    assert all("secure" not in cookie.lower().split("; ") for cookie in out["set_cookie"])


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        # Each of the three public-facing markers on its own forces the gates.
        (
            {"AUTHTOTP_ALLOWED_HOSTS": "vault.example.com,127.0.0.1"},
            ["AUTHTOTP_REQUIRE_ADMIN_TOTP", "AUTHTOTP_COOKIE_SECURE", "vault.example.com"],
        ),
        ({"AUTHTOTP_ALLOWED_HOSTS": "*"}, ["AUTHTOTP_REQUIRE_ADMIN_TOTP", "AUTHTOTP_COOKIE_SECURE"]),
        (
            {"AUTHTOTP_ALLOWED_ORIGINS": "https://vault.example.com"},
            ["AUTHTOTP_ALLOWED_ORIGINS 非空", "AUTHTOTP_REQUIRE_ADMIN_TOTP"],
        ),
        ({"AUTHTOTP_COOKIE_SECURE": "1"}, ["AUTHTOTP_COOKIE_SECURE=1", "AUTHTOTP_REQUIRE_ADMIN_TOTP"]),
        # Gates on but plain-HTTP cookies.
        (
            {
                "AUTHTOTP_ALLOWED_HOSTS": "vault.example.com",
                "AUTHTOTP_REQUIRE_ADMIN_TOTP": "1",
                "AUTHTOTP_TRUSTED_PROXIES": "127.0.0.1",
            },
            ["未开启 AUTHTOTP_COOKIE_SECURE"],
        ),
    ],
)
def test_public_facing_without_gates_refuses_to_load(clean_env, values, expected):
    with pytest.raises(ValueError) as excinfo:
        _load_with(clean_env, values)
    message = str(excinfo.value)
    assert "对外配置" in message
    # Every refusal names the explicit intranet escape hatch and what it waives.
    assert "AUTHTOTP_ALLOW_REMOTE_SETUP=1，它同时免除以上两项要求" in message
    for fragment in expected:
        assert fragment in message


@pytest.mark.parametrize(
    ("drop", "expected"),
    [
        ("AUTHTOTP_REQUIRE_ADMIN_TOTP", ["AUTHTOTP_REQUIRE_ADMIN_TOTP", "AUTHTOTP_ALLOW_REMOTE_SETUP"]),
        ("AUTHTOTP_COOKIE_SECURE", ["AUTHTOTP_COOKIE_SECURE"]),
        # Turning the requirement on pulls in the existing trusted-proxy check.
        ("AUTHTOTP_TRUSTED_PROXIES", ["AUTHTOTP_TRUSTED_PROXIES"]),
    ],
)
def test_example_missing_one_line_refuses_to_load(clean_env, drop, expected):
    values = _example_settings()
    values.pop(drop)
    with pytest.raises(ValueError) as excinfo:
        _load_with(clean_env, values)
    for fragment in expected:
        assert fragment in str(excinfo.value)


def test_local_default_process_starts(tmp_path):
    env = _subprocess_env(
        tmp_path, {"AUTHTOTP_MASTER_KEY": base64.urlsafe_b64encode(b"L" * 32).decode("ascii")}
    )
    result = _run(START_AND_PROBE, env)
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["health"] == 200
    assert out["status"]["totp_required"] is False


def test_deploy_example_process_starts(tmp_path):
    key_file = tmp_path / "master-key"
    key_file.write_text(base64.urlsafe_b64encode(b"E" * 32).decode("ascii") + "\n", encoding="ascii")
    key_file.chmod(0o400)
    env = _subprocess_env(tmp_path, {**_example_settings(), "AUTHTOTP_MASTER_KEY_FILE": str(key_file)})
    result = _run(START_AND_PROBE, env)
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["health"] == 200
    assert out["status"]["totp_required"] is True


def test_public_process_without_admin_totp_refuses_to_start(tmp_path):
    values = _example_settings()
    values.pop("AUTHTOTP_REQUIRE_ADMIN_TOTP")
    env = _subprocess_env(
        tmp_path,
        {**values, "AUTHTOTP_MASTER_KEY": base64.urlsafe_b64encode(b"R" * 32).decode("ascii")},
    )
    result = _run("import backend.app.main", env)
    assert result.returncode != 0
    assert "AUTHTOTP_REQUIRE_ADMIN_TOTP" in result.stderr
    assert "AUTHTOTP_ALLOW_REMOTE_SETUP" in result.stderr
    assert not (tmp_path / "vault.db").exists()


# ---- Fix C: an unlisted reverse proxy on loopback is not "local" ---------------------------


@pytest.fixture()
def gated(client, monkeypatch):
    """REQUIRE_ADMIN_TOTP on, but the loopback reverse proxy was left out of TRUSTED_PROXIES."""
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, require_admin_totp=True, trusted_proxies=("10.0.0.2",)),
    )
    return client


def _loopback_peer() -> TestClient:
    return TestClient(app, client=("127.0.0.1", 41000))


def _audit_rows() -> list[tuple]:
    with database() as connection:
        return [
            (row["action"], row["result"], row["reason"])
            for row in connection.execute("SELECT * FROM audit_events ORDER BY id")
        ]


@pytest.mark.parametrize(
    "header",
    [
        {"X-Forwarded-For": "198.51.100.7"},
        {"Forwarded": "for=198.51.100.7;proto=https"},
        {"X-Real-IP": "198.51.100.7"},
    ],
)
def test_bootstrap_via_unlisted_loopback_proxy_is_refused(gated, header):
    response = _loopback_peer().post("/api/auth/bootstrap", json={"password": PASSWORD}, headers=header)
    assert response.status_code == 403
    assert response.json() == {"detail": "BOOTSTRAP_LOCAL_ONLY"}
    assert _audit_rows() == [("admin.bootstrap", "denied", "bootstrap_local_only")]
    with database() as connection:
        assert connection.execute("SELECT 1 FROM admin_auth").fetchone() is None


def test_bootstrap_over_ssh_tunnel_still_works(gated):
    response = _loopback_peer().post("/api/auth/bootstrap", json={"password": PASSWORD})
    assert response.status_code == 200
    assert _audit_rows() == [("admin.bootstrap", "success", None)]


@pytest.mark.parametrize("header", ["X-Forwarded-For", "Forwarded", "X-Real-IP"])
def test_unenrolled_login_via_unlisted_loopback_proxy_is_refused(gated, header):
    assert _loopback_peer().post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    value = "for=198.51.100.7" if header == "Forwarded" else "198.51.100.7"
    proxied = _loopback_peer().post("/api/auth/login", json={"password": PASSWORD}, headers={header: value})
    assert proxied.status_code == 403
    assert proxied.json() == {"detail": "ADMIN_TOTP_NOT_ENROLLED"}
    tunnel = _loopback_peer().post("/api/auth/login", json={"password": PASSWORD})
    assert tunnel.status_code == 200


# ---- trusted proxy that names the client only via X-Real-IP / Forwarded -------------------


@pytest.fixture()
def behind_trusted_proxy(client, monkeypatch):
    """Correct deployment settings: REQUIRE_ADMIN_TOTP on, the loopback proxy is trusted."""
    monkeypatch.setattr(
        main_module,
        "settings",
        replace(main_module.settings, require_admin_totp=True, trusted_proxies=("127.0.0.1",)),
    )
    return client


@pytest.mark.parametrize(
    "header",
    [{"X-Real-IP": "198.51.100.7"}, {"Forwarded": "for=198.51.100.7;proto=https"}],
)
def test_bootstrap_via_trusted_proxy_without_xff_is_refused(behind_trusted_proxy, header):
    response = _loopback_peer().post("/api/auth/bootstrap", json={"password": PASSWORD}, headers=header)
    assert response.status_code == 403
    assert response.json() == {"detail": "BOOTSTRAP_LOCAL_ONLY"}
    with database() as connection:
        assert connection.execute("SELECT 1 FROM admin_auth").fetchone() is None


@pytest.mark.parametrize("header", ["X-Real-IP", "Forwarded"])
def test_unenrolled_login_via_trusted_proxy_without_xff_is_refused(behind_trusted_proxy, header):
    assert _loopback_peer().post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    value = "for=198.51.100.7" if header == "Forwarded" else "198.51.100.7"
    proxied = _loopback_peer().post("/api/auth/login", json={"password": PASSWORD}, headers={header: value})
    assert proxied.status_code == 403
    assert proxied.json() == {"detail": "ADMIN_TOTP_NOT_ENROLLED"}


def test_ssh_tunnel_to_trusted_proxy_address_stays_local(behind_trusted_proxy):
    """No forwarding headers at all (SSH tunnel lands on 127.0.0.1, which is also the trusted proxy)."""
    assert _loopback_peer().post("/api/auth/bootstrap", json={"password": PASSWORD}).status_code == 200
    assert _loopback_peer().post("/api/auth/login", json={"password": PASSWORD}).status_code == 200
    # A real X-Forwarded-For still wins over X-Real-IP: the resolved remote source is refused.
    both = _loopback_peer().post(
        "/api/auth/login",
        json={"password": PASSWORD},
        headers={"X-Forwarded-For": "198.51.100.7", "X-Real-IP": "198.51.100.7"},
    )
    assert both.status_code == 403
