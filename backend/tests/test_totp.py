from __future__ import annotations

import base64

import pytest

from backend.app.totp import InvalidTotpError, generate_code, parse_otpauth_uri


RFC_SHA1_SECRET = base64.b32encode(b"12345678901234567890").decode("ascii")


@pytest.mark.parametrize(
    ("timestamp", "expected"),
    [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"), (1234567890, "89005924"), (2000000000, "69279037")],
)
def test_rfc6238_sha1_vectors(timestamp, expected):
    result = generate_code(RFC_SHA1_SECRET, "SHA1", 8, 30, at=timestamp)
    assert result["code"] == expected


def test_parse_standard_uri():
    definition = parse_otpauth_uri(
        "otpauth://totp/GitHub%3Ademo?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=6&period=45"
    )
    assert definition.issuer == "GitHub"
    assert definition.account_ref == "demo"
    assert definition.algorithm == "SHA256"
    assert definition.period_seconds == 45


def test_rejects_hotp_and_invalid_seed():
    with pytest.raises(InvalidTotpError):
        parse_otpauth_uri("otpauth://hotp/test?secret=JBSWY3DPEHPK3PXP")
    with pytest.raises(InvalidTotpError):
        parse_otpauth_uri("otpauth://totp/test?secret=not-a-seed")
    with pytest.raises(InvalidTotpError, match="密钥为空"):
        parse_otpauth_uri("otpauth://totp/test?secret=&issuer=Example")
    with pytest.raises(InvalidTotpError):
        parse_otpauth_uri(
            "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&digits=six"
        )
