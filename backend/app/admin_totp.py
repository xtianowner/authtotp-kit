"""Administrator second factor: TOTP from an authenticator app plus one-time recovery codes.

Storage rules:
- The admin TOTP seed (pending and active) is encrypted exactly like entry seeds
  (per-value DEK + AES-256-GCM, DEK wrapped by the master key), bound to ADMIN_TOTP_BINDING.
- Recovery codes are stored only as HMAC-SHA256 digests keyed by an HKDF subkey of the
  master key, so a copied database alone cannot brute-force the 8-character codes offline.
- Every accepted TOTP time step is recorded; a step can be used at most once (replay guard).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass

import pyotp
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .crypto import decrypt_seed, encrypt_seed, get_master_key
from .security import iso_now


ADMIN_TOTP_BINDING = "admin:totp"
ADMIN_TOTP_ISSUER = "AuthTOTP"
ADMIN_TOTP_ACCOUNT = "vault"
TOTP_PERIOD_SECONDS = 30
TOTP_DIGITS = 6
TOTP_VALID_WINDOW = 1
RECOVERY_CODE_COUNT = 10
RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_RECOVERY_KDF_INFO = b"AuthTOTP admin recovery codes v1"
_TOTP_PATTERN = re.compile(r"\d{6}")
_RECOVERY_PATTERN = re.compile(f"[{RECOVERY_ALPHABET}]{{8}}")


@dataclass(frozen=True)
class CodeMatch:
    kind: str  # "totp" | "recovery_code"
    step: int | None = None
    code_hash: str | None = None


def _state(connection: sqlite3.Connection) -> sqlite3.Row | None:
    return connection.execute("SELECT * FROM admin_totp WHERE id = 1").fetchone()


def is_enrolled(connection: sqlite3.Connection) -> bool:
    row = _state(connection)
    return bool(row and row["seed_ciphertext"] is not None)


def has_pending(connection: sqlite3.Connection) -> bool:
    row = _state(connection)
    return bool(row and row["pending_seed_ciphertext"] is not None)


def _totp(secret: str) -> pyotp.TOTP:
    return pyotp.TOTP(secret, digits=TOTP_DIGITS, interval=TOTP_PERIOD_SECONDS)


def _match_step(secret: str, code: str, *, after_step: int, now: float | None = None) -> int | None:
    """Return the accepted time step for `code`, only if it is newer than `after_step`."""
    if not _TOTP_PATTERN.fullmatch(code):
        return None
    totp = _totp(secret)
    current = int(now if now is not None else time.time()) // TOTP_PERIOD_SECONDS
    matched: int | None = None
    for step in range(current - TOTP_VALID_WINDOW, current + TOTP_VALID_WINDOW + 1):
        if step > after_step and hmac.compare_digest(totp.generate_otp(step), code):
            matched = step
    return matched


def _recovery_key() -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=_RECOVERY_KDF_INFO
    ).derive(get_master_key())


def normalize_recovery_code(code: str) -> str | None:
    compact = re.sub(r"[\s-]", "", code).upper()
    return compact if _RECOVERY_PATTERN.fullmatch(compact) else None


def _recovery_digest(key: bytes, normalized: str) -> str:
    return hmac.new(key, normalized.encode("ascii"), hashlib.sha256).hexdigest()


def _generate_recovery_codes() -> list[str]:
    codes: list[str] = []
    while len(codes) < RECOVERY_CODE_COUNT:
        raw = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(8))
        if raw not in codes:
            codes.append(raw)
    return [f"{code[:4]}-{code[4:]}" for code in codes]


def replace_recovery_codes(connection: sqlite3.Connection) -> list[str]:
    """Invalidate all existing recovery codes and return 10 new plaintext codes (shown once)."""
    codes = _generate_recovery_codes()
    key = _recovery_key()
    now = iso_now()
    connection.execute("DELETE FROM admin_recovery_codes")
    connection.executemany(
        "INSERT INTO admin_recovery_codes(code_hash, created_at) VALUES (?, ?)",
        [(_recovery_digest(key, code.replace("-", "")), now) for code in codes],
    )
    return codes


def begin_setup(connection: sqlite3.Connection) -> dict[str, str]:
    """Create (or replace) the pending seed. Caller must ensure TOTP is not yet enrolled."""
    secret = base64.b32encode(secrets.token_bytes(20)).decode("ascii")
    now = iso_now()
    connection.execute(
        """
        INSERT INTO admin_totp(id, pending_seed_ciphertext, pending_created_at, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            pending_seed_ciphertext = excluded.pending_seed_ciphertext,
            pending_created_at = excluded.pending_created_at,
            updated_at = excluded.updated_at
        """,
        (encrypt_seed(secret, ADMIN_TOTP_BINDING), now, now),
    )
    uri = _totp(secret).provisioning_uri(name=ADMIN_TOTP_ACCOUNT, issuer_name=ADMIN_TOTP_ISSUER)
    return {"otpauth_uri": uri, "secret_base32": secret}


def match_pending(connection: sqlite3.Connection, code: str) -> int | None:
    row = _state(connection)
    if not row or row["pending_seed_ciphertext"] is None:
        return None
    secret = decrypt_seed(row["pending_seed_ciphertext"], ADMIN_TOTP_BINDING)
    return _match_step(secret, code.strip(), after_step=-1)


def activate_pending(connection: sqlite3.Connection, step: int) -> bool:
    """Promote the pending seed; the confirming step is marked used so it cannot be replayed."""
    now = iso_now()
    cursor = connection.execute(
        """
        UPDATE admin_totp
        SET seed_ciphertext = pending_seed_ciphertext,
            enabled_at = ?,
            last_used_step = ?,
            pending_seed_ciphertext = NULL,
            pending_created_at = NULL,
            updated_at = ?
        WHERE id = 1 AND seed_ciphertext IS NULL AND pending_seed_ciphertext IS NOT NULL
        """,
        (now, step, now),
    )
    return cursor.rowcount == 1


def find_code_match(connection: sqlite3.Connection, code: str) -> CodeMatch | None:
    """Check a TOTP or recovery code against the active enrollment without consuming it."""
    row = _state(connection)
    if not row or row["seed_ciphertext"] is None:
        return None
    candidate = code.strip()
    if _TOTP_PATTERN.fullmatch(candidate):
        secret = decrypt_seed(row["seed_ciphertext"], ADMIN_TOTP_BINDING)
        step = _match_step(secret, candidate, after_step=row["last_used_step"])
        return CodeMatch("totp", step=step) if step is not None else None
    normalized = normalize_recovery_code(candidate)
    if normalized is None:
        return None
    digest = _recovery_digest(_recovery_key(), normalized)
    hit = connection.execute(
        "SELECT 1 FROM admin_recovery_codes WHERE code_hash = ? AND used_at IS NULL", (digest,)
    ).fetchone()
    return CodeMatch("recovery_code", code_hash=digest) if hit else None


def consume(connection: sqlite3.Connection, match: CodeMatch) -> bool:
    """Atomically mark the code used; False when a concurrent request already used it."""
    now = iso_now()
    if match.kind == "totp":
        cursor = connection.execute(
            """
            UPDATE admin_totp SET last_used_step = ?, updated_at = ?
            WHERE id = 1 AND seed_ciphertext IS NOT NULL AND last_used_step < ?
            """,
            (match.step, now, match.step),
        )
    else:
        cursor = connection.execute(
            "UPDATE admin_recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
            (now, match.code_hash),
        )
    return cursor.rowcount == 1


def disable(connection: sqlite3.Connection) -> None:
    connection.execute("DELETE FROM admin_totp")
    connection.execute("DELETE FROM admin_recovery_codes")
