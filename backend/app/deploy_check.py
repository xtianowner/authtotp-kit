"""Installer-side checks that use the backend's own origin rules (stdlib only, no settings import).

    python3 -m backend.app.deploy_check urls --public <domain|URL> --vault <domain|URL> [--external-https]
    python3 -m backend.app.deploy_check env <env file> --vault-url <https URL>

`urls` prints KEY=value lines for deploy/install.sh. `env` exits 0 when an existing env file already serves the
vault URL. Both exit 1 with the reason on stderr; `env` never prints values other than the origin/host at fault.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .network import normalize_origin


DOMAIN = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")
KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class CheckError(ValueError):
    """A problem the operator has to fix; the message says which."""


@dataclass(frozen=True)
class Site:
    url: str  # normalized origin, e.g. https://vault.example.com or https://vault.example.com:8443
    host: str
    port: int

    @property
    def site(self) -> str:
        """Caddy site address: the host, plus the port when it is not 443."""
        return self.host if self.port == 443 else f"{self.host}:{self.port}"


def parse_site(value: str, flag: str, external: bool) -> Site:
    raw = value.strip()
    if not raw:
        raise CheckError(f"{flag} is required")
    candidate = raw if "://" in raw else f"https://{raw}"
    origin = normalize_origin(candidate)
    if origin is None:
        raise CheckError(f"{flag} {raw!r} must be a domain like vault.example.com or an address like "
                         "https://vault.example.com:8443 (no path)")
    parts = urlsplit(origin)
    if parts.scheme != "https":
        raise CheckError(f"{flag} {raw!r} must use https")
    host = parts.hostname or ""
    if not DOMAIN.fullmatch(host) or host.rsplit(".", 1)[-1].isdigit():
        raise CheckError(f"{flag} {raw!r} must be a domain name like vault.example.com (an IP address does not work)")
    port = parts.port or 443
    if port != 443 and not external:
        raise CheckError(f"{flag} {raw!r}: a port other than 443 needs --external-https "
                         "(your own HTTPS front; see AGENTS.md §12)")
    return Site(url=origin, host=host, port=port)


def site_pair(public: str, vault: str, external: bool) -> tuple[Site, Site]:
    public_site = parse_site(public, "--public", external)
    vault_site = parse_site(vault, "--vault", external)
    if public_site.host == vault_site.host:
        raise CheckError("--public and --vault must use two different domains (they are isolated on purpose; "
                         "a different port on the same domain is not enough)")
    return public_site, vault_site


def read_env_file(text: str) -> dict[str, str]:
    """The subset of systemd EnvironmentFile= syntax AuthTOTP supports; anything else is refused, not guessed.

    Blank lines and lines starting with # or ; are skipped, surrounding whitespace is dropped, a value may be
    wrapped in one pair of matching quotes on the same line, and a later assignment replaces an earlier one.
    Backslashes, multi-line quotes and lines without KEY= are rejected with their line number.
    """
    values: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped[0] in "#;":
            continue
        key, sep, value = stripped.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not KEY.fullmatch(key):
            raise CheckError(f"line {number} is not a KEY=value setting")
        if "\\" in value:
            raise CheckError(f"line {number} ({key}) contains a backslash; write the value without escapes")
        if value[:1] in ("'", '"'):
            if len(value) < 2 or value[-1] != value[0] or value[0] in value[1:-1]:
                raise CheckError(f"line {number} ({key}) has unbalanced quotes; keep one quoted value per line")
            value = value[1:-1]
        values[key] = value
    return values


def _csv(raw: str) -> list[str]:
    """Same split as backend/app/config.py `_csv`."""
    return [item.strip() for item in raw.split(",") if item.strip()]


def _host_allowed(host: str, patterns: list[str]) -> bool:
    """Starlette TrustedHostMiddleware matching: exact name, '*', or a '*.suffix' wildcard."""
    return any(host == p or (p.startswith("*") and host.endswith(p[1:])) for p in patterns)


def check_env(text: str, vault: Site) -> None:
    values = read_env_file(text)
    origins = _csv(values.get("AUTHTOTP_ALLOWED_ORIGINS", ""))
    if not origins:
        raise CheckError(f"AUTHTOTP_ALLOWED_ORIGINS is missing or empty; it must include {vault.url}")
    normalized = set()
    for item in origins:
        origin = normalize_origin(item)
        if origin is None:
            raise CheckError(f"AUTHTOTP_ALLOWED_ORIGINS has {item!r}, which is not a full origin like "
                             "https://vault.example.com (the service would refuse to start)")
        normalized.add(origin)
    if vault.url not in normalized:
        raise CheckError(f"AUTHTOTP_ALLOWED_ORIGINS does not include {vault.url}")
    hosts = [host.lower() for host in _csv(values.get("AUTHTOTP_ALLOWED_HOSTS", ""))]
    if not _host_allowed(vault.host, hosts):
        raise CheckError(f"AUTHTOTP_ALLOWED_HOSTS does not include {vault.host}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m backend.app.deploy_check")
    commands = parser.add_subparsers(dest="command", required=True)
    urls = commands.add_parser("urls")
    urls.add_argument("--public", default="")
    urls.add_argument("--vault", default="")
    urls.add_argument("--external-https", action="store_true")
    env = commands.add_parser("env")
    env.add_argument("path", type=Path)
    env.add_argument("--vault-url", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "urls":
            public, vault = site_pair(args.public, args.vault, args.external_https)
            for name, site in (("PUBLIC", public), ("VAULT", vault)):
                print(f"{name}_URL={site.url}")
                print(f"{name}_HOST={site.host}")
                print(f"{name}_PORT={site.port}")
                print(f"{name}_SITE={site.site}")
        else:
            vault = parse_site(args.vault_url, "--vault-url", external=True)
            try:
                text = args.path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                raise CheckError(f"cannot read {args.path}: {exc.__class__.__name__}") from exc
            check_env(text, vault)
    except CheckError as exc:
        print(f"    {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
