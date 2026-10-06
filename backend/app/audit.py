from __future__ import annotations

import sqlite3

from .security import iso_now


def write_audit(
    connection: sqlite3.Connection,
    *,
    request_id: str,
    actor_type: str,
    action: str,
    result: str,
    actor_id: str | None = None,
    entry_id: str | None = None,
    reason: str | None = None,
    source: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO audit_events
            (occurred_at, request_id, actor_type, actor_id, action, entry_id, result, reason, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            iso_now(),
            request_id,
            actor_type,
            actor_id,
            action,
            entry_id,
            result,
            reason,
            source,
        ),
    )

