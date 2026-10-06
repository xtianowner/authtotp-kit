"""Pure helpers for request-origin trust decisions (no settings import, unit-testable)."""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from urllib.parse import urlparse, urlsplit


LOCAL_ORIGIN_HOSTS = {"127.0.0.1", "localhost"}
UNKNOWN_SOURCE = "unknown"


def normalize_ip(value: str) -> str | None:
    """Return the canonical text form of an IP address, or None when it is not an IP."""
    candidate = value.strip()
    if candidate.startswith("[") and "]" in candidate:
        candidate = candidate[1 : candidate.index("]")]
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.compressed


def is_loopback(value: str) -> bool:
    normalized = normalize_ip(value)
    return normalized is not None and ipaddress.ip_address(normalized).is_loopback


def resolve_client_ip(
    peer: str | None,
    forwarded_for: Iterable[str],
    trusted_proxies: Iterable[str],
) -> str:
    """Pick the request source.

    Only when the direct peer is a configured trusted proxy is X-Forwarded-For consulted;
    the result is the right-most hop that is not itself a trusted proxy. Any XFF sent by a
    non-trusted peer is ignored, so it cannot be used to spoof the source.
    """
    if not peer:
        return UNKNOWN_SOURCE
    trusted = set(trusted_proxies)
    peer_ip = normalize_ip(peer)
    if not trusted or peer_ip is None or peer_ip not in trusted:
        return peer
    hops = [hop.strip() for value in forwarded_for for hop in value.split(",") if hop.strip()]
    for hop in reversed(hops):
        hop_ip = normalize_ip(hop)
        if hop_ip is None:
            return UNKNOWN_SOURCE
        if hop_ip not in trusted:
            return hop_ip
    if hops:
        return normalize_ip(hops[0]) or UNKNOWN_SOURCE
    return peer_ip


def normalize_origin(value: str) -> str | None:
    """Canonical `scheme://host[:port]`; None when the value is not a bare http(s) origin."""
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https") or not parsed.hostname:
        return None
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 443 if scheme == "https" else 80
    if port is None or port == default_port:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def origin_allowed(origin: str, host_header: str | None, allowed_origins: Iterable[str]) -> bool:
    """Same-origin local HTTP (original rule) or an explicitly configured origin."""
    try:
        parsed = urlparse(origin)
        parsed.hostname  # noqa: B018 - raises ValueError on malformed IPv6 netloc
    except ValueError:
        return False
    same_local_origin = (
        parsed.scheme == "http"
        and parsed.hostname in LOCAL_ORIGIN_HOSTS
        and parsed.netloc == host_header
    )
    if same_local_origin:
        return True
    normalized = normalize_origin(origin)
    return normalized is not None and normalized in set(allowed_origins)
