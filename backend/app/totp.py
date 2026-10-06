from __future__ import annotations

import base64
import binascii
import hashlib
import time
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlparse

import pyotp


SUPPORTED_ALGORITHMS = {
    "SHA1": hashlib.sha1,
    "SHA256": hashlib.sha256,
    "SHA512": hashlib.sha512,
}


class InvalidTotpError(ValueError):
    pass


@dataclass(frozen=True)
class TotpDefinition:
    seed: str
    label: str
    issuer: str
    account_ref: str
    algorithm: str
    digits: int
    period_seconds: int


def normalize_seed(seed: str) -> str:
    normalized = "".join(seed.strip().split()).upper().rstrip("=")
    if len(normalized) < 16:
        raise InvalidTotpError("TOTP 密钥过短或不完整。")
    padded = normalized + "=" * ((8 - len(normalized) % 8) % 8)
    try:
        decoded = base64.b32decode(padded, casefold=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidTotpError("TOTP 密钥不是有效的 Base32。") from exc
    if len(decoded) < 10:
        raise InvalidTotpError("TOTP 密钥强度不足。")
    return normalized


def parse_otpauth_uri(uri: str) -> TotpDefinition:
    parsed = urlparse(uri.strip())
    if parsed.scheme != "otpauth" or parsed.netloc.lower() != "totp":
        raise InvalidTotpError("仅支持 otpauth://totp/... 格式。")
    params = parse_qs(parsed.query, keep_blank_values=True)
    if "secret" not in params:
        raise InvalidTotpError("二维码内容缺少 TOTP 密钥。")
    if not params["secret"][0].strip():
        raise InvalidTotpError("二维码中的 TOTP 密钥为空。")
    seed = normalize_seed(params["secret"][0])
    raw_label = unquote(parsed.path.lstrip("/"))
    issuer_from_label, separator, account = raw_label.partition(":")
    issuer = params.get("issuer", [issuer_from_label if separator else ""])[0].strip()
    account_ref = (account if separator else raw_label).strip()
    algorithm = params.get("algorithm", ["SHA1"])[0].upper()
    try:
        digits = int(params.get("digits", ["6"])[0])
        period = int(params.get("period", ["30"])[0])
    except ValueError as exc:
        raise InvalidTotpError("验证码位数与周期必须是整数。") from exc
    validate_parameters(algorithm, digits, period)
    label = raw_label or account_ref or issuer or "未命名条目"
    return TotpDefinition(seed, label, issuer, account_ref, algorithm, digits, period)


def validate_parameters(algorithm: str, digits: int, period_seconds: int) -> None:
    if algorithm not in SUPPORTED_ALGORITHMS:
        raise InvalidTotpError("算法仅支持 SHA1、SHA256 或 SHA512。")
    if digits not in (6, 7, 8):
        raise InvalidTotpError("验证码位数仅支持 6、7 或 8。")
    if period_seconds < 15 or period_seconds > 120:
        raise InvalidTotpError("验证码周期必须在 15–120 秒之间。")


def generate_code(
    seed: str,
    algorithm: str,
    digits: int,
    period_seconds: int,
    at: float | None = None,
) -> dict[str, int | str | bool]:
    validate_parameters(algorithm, digits, period_seconds)
    timestamp = int(at if at is not None else time.time())
    valid_from = timestamp - timestamp % period_seconds
    valid_until = valid_from + period_seconds
    totp = pyotp.TOTP(
        seed,
        digits=digits,
        interval=period_seconds,
        digest=SUPPORTED_ALGORITHMS[algorithm],
    )
    return {
        "code": totp.at(timestamp),
        "digits": digits,
        "period_seconds": period_seconds,
        "valid_from_epoch": valid_from,
        "valid_until_epoch": valid_until,
        "remaining_seconds": max(0, valid_until - timestamp),
    }
