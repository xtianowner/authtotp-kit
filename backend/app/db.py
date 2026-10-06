from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterator

from .config import settings
from .security import NEVER_EXPIRES


# meta key: the "default 0 → still-valid callers become never-expiring" migration has run.
CALLER_NEVER_EXPIRE_MIGRATED = "caller_never_expire_migrated"

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    issuer TEXT NOT NULL,
    account_ref TEXT NOT NULL,
    purpose TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    digits INTEGER NOT NULL,
    period_seconds INTEGER NOT NULL,
    seed_ciphertext BLOB NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS callers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    purpose TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS caller_entries (
    caller_id TEXT NOT NULL REFERENCES callers(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    PRIMARY KEY (caller_id, entry_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    entry_id TEXT,
    result TEXT NOT NULL,
    reason TEXT,
    source TEXT
);

CREATE TABLE IF NOT EXISTS admin_totp (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seed_ciphertext BLOB,
    enabled_at TEXT,
    last_used_step INTEGER NOT NULL DEFAULT 0,
    pending_seed_ciphertext BLOB,
    pending_created_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((seed_ciphertext IS NULL) = (enabled_at IS NULL))
);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
    code_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_occurred_at ON audit_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_caller_entries_entry ON caller_entries(entry_id);
"""


def _connect(path: Path | None = None) -> sqlite3.Connection:
    target = path or settings.database_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.parent.chmod(0o700)
    connection = sqlite3.connect(target, timeout=5, check_same_thread=False)
    target.chmod(0o600)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def initialize_database(path: Path | None = None) -> None:
    with _connect(path) as connection:
        connection.executescript(SCHEMA)
        caller_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(callers)").fetchall()
        }
        if "expires_at" not in caller_columns:
            connection.execute("ALTER TABLE callers ADD COLUMN expires_at TEXT")
            # A pre-migration bearer credential must not silently become long-lived.
            connection.execute(
                "UPDATE callers SET expires_at = ? WHERE expires_at IS NULL",
                (datetime.now(UTC).isoformat(),),
            )
        already_migrated = connection.execute(
            "SELECT 1 FROM meta WHERE key = ?", (CALLER_NEVER_EXPIRE_MIGRATED,)
        ).fetchone()
        if settings.caller_token_hours <= 0 and not already_migrated:
            # One-time: only callers that are still valid become never-expiring; an already expired
            # bearer credential must stay expired across restarts. julianday() compares instants,
            # so it does not depend on how the stored timestamp spells its UTC offset.
            # The marker is written in the same transaction, so later starts keep tokens created
            # with an explicit lifetime (expires_in_hours) at their own expiry.
            connection.execute(
                """
                UPDATE callers SET expires_at = ?
                WHERE status = 'active' AND expires_at != ?
                  AND julianday(expires_at) > julianday(?)
                """,
                (NEVER_EXPIRES, NEVER_EXPIRES, datetime.now(UTC).isoformat()),
            )
            connection.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, '1')",
                (CALLER_NEVER_EXPIRE_MIGRATED,),
            )
    target = path or settings.database_path
    target.chmod(0o600)


@contextmanager
def database(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    connection = _connect(path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
