from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .network import normalize_ip, normalize_origin


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ALLOWED_HOSTS: tuple[str, ...] = ("127.0.0.1", "localhost", "testserver")
# Host names that only a local process can use; any other allowed host makes the install internet-facing.
LOCAL_ONLY_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]", "testserver"})
_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"", "0", "false", "no", "off"}


def _csv(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def _flag(name: str) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    raise ValueError(f"{name} 只接受 1/true/yes/on 或 0/false/no/off，当前值无法识别。")


def _allowed_hosts() -> tuple[str, ...]:
    hosts = tuple(host.lower() for host in _csv("AUTHTOTP_ALLOWED_HOSTS"))
    return hosts or DEFAULT_ALLOWED_HOSTS


def _allowed_origins() -> tuple[str, ...]:
    origins: list[str] = []
    for item in _csv("AUTHTOTP_ALLOWED_ORIGINS"):
        normalized = normalize_origin(item)
        if normalized is None:
            raise ValueError(
                f"AUTHTOTP_ALLOWED_ORIGINS 中的 {item!r} 不是完整 origin，应形如 https://vault.example.com。"
            )
        origins.append(normalized)
    return tuple(dict.fromkeys(origins))


def _trusted_proxies() -> tuple[str, ...]:
    proxies: list[str] = []
    for item in _csv("AUTHTOTP_TRUSTED_PROXIES"):
        normalized = normalize_ip(item)
        if normalized is None:
            raise ValueError(f"AUTHTOTP_TRUSTED_PROXIES 中的 {item!r} 不是 IP 地址。")
        proxies.append(normalized)
    return tuple(dict.fromkeys(proxies))


def public_facing_reasons(
    allowed_hosts: tuple[str, ...], allowed_origins: tuple[str, ...], cookie_secure: bool
) -> list[str]:
    """Why this configuration counts as reachable from other machines; empty = local-only."""
    reasons: list[str] = []
    remote_hosts = [host for host in allowed_hosts if host not in LOCAL_ONLY_HOSTS]
    if remote_hosts:
        reasons.append(f"AUTHTOTP_ALLOWED_HOSTS 含非本机主机 {', '.join(remote_hosts)}")
    if allowed_origins:
        reasons.append("AUTHTOTP_ALLOWED_ORIGINS 非空")
    if cookie_secure:
        reasons.append("AUTHTOTP_COOKIE_SECURE=1")
    return reasons


def _check_combination(
    require_admin_totp: bool,
    trusted_proxies: tuple[str, ...],
    public_reasons: list[str] | None = None,
    cookie_secure: bool = False,
    allow_remote_setup: bool = False,
) -> None:
    if require_admin_totp and not trusted_proxies:
        raise ValueError(
            "AUTHTOTP_REQUIRE_ADMIN_TOTP 已开启，但 AUTHTOTP_TRUSTED_PROXIES 为空，拒绝启动："
            "经反向代理进来的公网请求在服务看来都来自代理所在的回环地址，会被当成回环来源，"
            "从而绕过“首次设置与未绑定登录仅限回环”门禁和全局失败上限。"
            "请把反向代理地址（同机 Caddy 为 127.0.0.1）写入 AUTHTOTP_TRUSTED_PROXIES，"
            "或关闭 AUTHTOTP_REQUIRE_ADMIN_TOTP。"
        )
    if not public_reasons or allow_remote_setup:
        # Local-only, or explicit trusted-intranet mode (remote first-time setup and plain-HTTP cookies accepted).
        return
    why = "；".join(public_reasons)
    problems: list[str] = []
    if not require_admin_totp:
        problems.append(
            "未开启 AUTHTOTP_REQUIRE_ADMIN_TOTP：任何人都能抢在你之前打开这个地址、设置管理密码并接管保险库。"
            "请设置 AUTHTOTP_REQUIRE_ADMIN_TOTP=1，同时把反向代理地址写入 AUTHTOTP_TRUSTED_PROXIES"
            "（同机 Caddy 为 127.0.0.1），首次设置经 SSH 隧道从本机完成（参照 deploy/authtotp.env.example）。"
        )
    if not cookie_secure:
        problems.append(
            "未开启 AUTHTOTP_COOKIE_SECURE：登录会话 Cookie 会经明文 HTTP 发送。"
            "请经 HTTPS 访问并设置 AUTHTOTP_COOKIE_SECURE=1。"
        )
    if problems:
        raise ValueError(
            f"当前是对外配置（{why}），拒绝启动："
            + " ".join(f"({i}) {p}" for i, p in enumerate(problems, 1))
            + " 若确定只在可信内网使用（可以是纯 HTTP），并接受“第一个访问者可以设置管理密码”，"
            "可改为显式设置 AUTHTOTP_ALLOW_REMOTE_SETUP=1，它同时免除以上两项要求。"
        )


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    database_path: Path
    frontend_dist: Path
    session_hours: int = 12
    code_min_remaining_seconds: int = 5
    rate_limit_per_minute: int = 10
    caller_token_hours: int = 0
    keychain_service: str = "authtotp.master"
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS
    allowed_origins: tuple[str, ...] = ()
    cookie_secure: bool = False
    trusted_proxies: tuple[str, ...] = ()
    require_admin_totp: bool = False
    allow_remote_setup: bool = False

    @classmethod
    def load(cls) -> "Settings":
        data_dir = Path(os.environ.get("AUTHTOTP_DATA_DIR", PROJECT_ROOT / ".data")).resolve()
        database_path = Path(
            os.environ.get("AUTHTOTP_DATABASE_PATH", data_dir / "authtotp.db")
        ).resolve()
        frontend_dist = Path(
            os.environ.get("AUTHTOTP_FRONTEND_DIST", PROJECT_ROOT / "dist")
        ).resolve()
        require_admin_totp = _flag("AUTHTOTP_REQUIRE_ADMIN_TOTP")
        trusted_proxies = _trusted_proxies()
        allowed_hosts = _allowed_hosts()
        allowed_origins = _allowed_origins()
        cookie_secure = _flag("AUTHTOTP_COOKIE_SECURE")
        allow_remote_setup = _flag("AUTHTOTP_ALLOW_REMOTE_SETUP")
        _check_combination(
            require_admin_totp,
            trusted_proxies,
            public_facing_reasons(allowed_hosts, allowed_origins, cookie_secure),
            cookie_secure,
            allow_remote_setup,
        )
        return cls(
            data_dir=data_dir,
            database_path=database_path,
            frontend_dist=frontend_dist,
            session_hours=int(os.environ.get("AUTHTOTP_SESSION_HOURS", "12")),
            code_min_remaining_seconds=int(
                os.environ.get("AUTHTOTP_CODE_MIN_REMAINING_SECONDS", "5")
            ),
            rate_limit_per_minute=int(
                os.environ.get("AUTHTOTP_RATE_LIMIT_PER_MINUTE", "10")
            ),
            caller_token_hours=int(os.environ.get("AUTHTOTP_CALLER_TOKEN_HOURS", "0")),
            # macOS 钥匙串里主密钥条目的服务名（只在没有 AUTHTOTP_MASTER_KEY / 密钥文件时使用）。
            keychain_service=os.environ.get("AUTHTOTP_KEYCHAIN_SERVICE", "authtotp.master").strip() or "authtotp.master",
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
            cookie_secure=cookie_secure,
            trusted_proxies=trusted_proxies,
            require_admin_totp=require_admin_totp,
            allow_remote_setup=allow_remote_setup,
        )


settings = Settings.load()
