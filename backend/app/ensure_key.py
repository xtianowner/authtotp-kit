from __future__ import annotations

from .crypto import ensure_keychain_key


if __name__ == "__main__":
    created = ensure_keychain_key()
    print("created" if created else "available")

