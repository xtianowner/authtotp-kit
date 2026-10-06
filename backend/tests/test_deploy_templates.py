"""deploy/ templates: the nginx reference must keep the Caddy site's protections, and install.sh's sed anchors exist."""

from __future__ import annotations

import re
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
# Public kit layout first (deploy/ at the root), then this repository's kit/public-root/deploy/.
DEPLOY = next(p for p in (ROOT / "deploy", ROOT / "kit" / "public-root" / "deploy") if p.is_dir())
CADDY = (DEPLOY / "Caddyfile.example").read_text()
NGINX = (DEPLOY / "nginx.conf.example").read_text()
ENV = (DEPLOY / "authtotp.env.example").read_text()
HEADERS = [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
]


def _block(text: str, marker: str) -> str:
    """The server/site block that follows the comment line starting with `marker`."""
    start = text.index(marker)
    following = re.search(r"^# ", text[start + len(marker):], re.M)
    return text[start: start + len(marker) + following.start()] if following else text[start:]


@pytest.mark.parametrize("name", HEADERS)
def test_public_tool_headers_match_between_caddy_and_nginx(name: str) -> None:
    caddy = re.search(rf'^\s*{name} "([^"]*)"', _block(CADDY, "# Public no-account tool"), re.M)
    nginx = re.search(rf'^\s*add_header {name} "([^"]*)" always;', _block(NGINX, "# Public no-account tool"), re.M)
    assert caddy and nginx, name
    assert caddy.group(1) == nginx.group(1)


def test_public_tool_csp_blocks_every_request() -> None:
    assert "connect-src 'none'" in _block(NGINX, "# Public no-account tool")
    assert "proxy_pass" not in _block(NGINX, "# Public no-account tool")


def test_vault_block_keeps_body_limit_redirect_and_forwarding() -> None:
    caddy = _block(CADDY, "# Private vault")
    nginx = _block(NGINX, "# Private vault")
    assert "max_size 64KB" in caddy and "client_max_body_size 64k;" in nginx
    assert "redir / https://totp.example.com/ 302" in caddy
    assert "return 302 https://totp.example.com/;" in nginx
    assert "reverse_proxy 127.0.0.1:18473" in caddy and "proxy_pass http://127.0.0.1:18473;" in nginx
    # Without it the vault sees every visitor as the SSH tunnel (loopback): first setup would be open to anyone.
    assert "proxy_set_header X-Forwarded-For $remote_addr;" in nginx
    assert 'add_header Strict-Transport-Security "max-age=31536000" always;' in nginx


def test_install_sh_anchors_exist() -> None:
    assert NGINX.count("443 ssl http2; # AuthTOTP vault") == 2
    assert NGINX.count("443 ssl http2; # AuthTOTP public tool") == 2
    assert re.search(r"^AUTHTOTP_ALLOWED_ORIGINS=https://vault\.example\.com$", ENV, re.M)
    assert re.search(r"^AUTHTOTP_ALLOWED_HOSTS=vault\.example\.com,", ENV, re.M)
