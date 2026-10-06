from __future__ import annotations

import sqlite3

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend.app.backup import backup_database
from backend.app.config import settings
from backend.app.crypto import decrypt_seed, encrypt_seed, get_master_key


def test_encryption_is_randomized_and_bound_to_entry():
    first = encrypt_seed("JBSWY3DPEHPK3PXP", "entry-a")
    second = encrypt_seed("JBSWY3DPEHPK3PXP", "entry-a")
    assert first.startswith(b"AT02")
    assert first != second
    assert decrypt_seed(first, "entry-a") == "JBSWY3DPEHPK3PXP"


def test_legacy_direct_ciphertext_remains_readable():
    nonce = b"N" * 12
    legacy = b"AT01" + nonce + AESGCM(get_master_key()).encrypt(
        nonce, b"JBSWY3DPEHPK3PXP", b"entry-old"
    )
    assert decrypt_seed(legacy, "entry-old") == "JBSWY3DPEHPK3PXP"


def test_sqlite_online_backup(admin_client):
    entry = admin_client.post(
        "/api/entries",
        json={"secret": "JBSWY3DPEHPK3PXP", "label": "Backup Test", "issuer": "Test"},
    ).json()
    caller = admin_client.post(
        "/api/callers",
        json={"name": "backup-caller", "purpose": "restore test", "allowed_entry_ids": [entry["id"]]},
    ).json()
    target = backup_database(keep=2)
    assert target and target.exists()
    with sqlite3.connect(target) as connection:
        assert connection.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM caller_entries WHERE caller_id = ? AND entry_id = ?",
            (caller["id"], entry["id"]),
        ).fetchone()[0] == 1
    assert b"JBSWY3DPEHPK3PXP" not in target.read_bytes()
    assert caller["token"].encode() not in target.read_bytes()
