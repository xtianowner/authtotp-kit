from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime
from pathlib import Path

from .config import settings


def backup_database(keep: int = 14) -> Path | None:
    source = settings.database_path
    if not source.exists():
        return None
    target_dir = settings.data_dir / "backups"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"authtotp-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    with sqlite3.connect(source) as source_connection, sqlite3.connect(target) as target_connection:
        source_connection.backup(target_connection)
    target.chmod(0o600)
    backups = sorted(target_dir.glob("authtotp-*.db"), reverse=True)
    for expired in backups[keep:]:
        expired.unlink()
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create an online SQLite backup.")
    parser.add_argument("--keep", type=int, default=14)
    args = parser.parse_args()
    result = backup_database(max(1, args.keep))
    print(result if result else "no-database-yet")

