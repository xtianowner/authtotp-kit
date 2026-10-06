"""Item 3: Linux master key from a file or a systemd credential; never auto-generated."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from backend.app import crypto
from backend.app.crypto import (
    KeyUnavailableError,
    decrypt_seed,
    encrypt_seed,
    ensure_keychain_key,
    get_master_key,
    master_key_file,
)
from backend.app.main import app


FILE_KEY = b"F" * 32
ENCODED_FILE_KEY = base64.urlsafe_b64encode(FILE_KEY).decode("ascii")


def _forbid_keychain(monkeypatch) -> list[tuple]:
    """Remove the test env key and make any /usr/bin/security call a hard failure."""
    calls: list[tuple] = []

    def forbidden(*args, **kwargs):
        calls.append(args)
        raise AssertionError("file key source must never call /usr/bin/security")

    monkeypatch.delenv("AUTHTOTP_MASTER_KEY", raising=False)
    monkeypatch.delenv("AUTHTOTP_MASTER_KEY_FILE", raising=False)
    monkeypatch.delenv("CREDENTIALS_DIRECTORY", raising=False)
    monkeypatch.setattr(crypto.subprocess, "run", forbidden)
    return calls


@pytest.fixture()
def no_keychain(monkeypatch):
    return _forbid_keychain(monkeypatch)


def _write_key(path, mode: int, content: str = ENCODED_FILE_KEY + "\n"):
    path.write_text(content, encoding="ascii")
    path.chmod(mode)
    return path


@pytest.mark.parametrize("mode", [0o600, 0o400])
def test_key_file_with_strict_mode_is_used(no_keychain, monkeypatch, tmp_path, mode):
    key_path = _write_key(tmp_path / "master.key", mode)
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(key_path))
    assert get_master_key() == FILE_KEY
    assert decrypt_seed(encrypt_seed("JBSWY3DPEHPK3PXP", "entry-f"), "entry-f") == "JBSWY3DPEHPK3PXP"
    assert ensure_keychain_key() is False
    assert no_keychain == []


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o644, 0o660, 0o610])
def test_key_file_with_group_or_other_bits_is_refused(no_keychain, monkeypatch, tmp_path, mode):
    key_path = _write_key(tmp_path / "master.key", mode)
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(key_path))
    with pytest.raises(KeyUnavailableError, match="权限过宽") as excinfo:
        get_master_key()
    assert f"{mode:04o}" in str(excinfo.value)
    assert ENCODED_FILE_KEY not in str(excinfo.value)
    assert no_keychain == []


def test_service_refuses_to_start_with_wide_key_file(no_keychain, monkeypatch, tmp_path):
    key_path = _write_key(tmp_path / "master.key", 0o644)
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(key_path))
    with pytest.raises(KeyUnavailableError, match="权限过宽"):
        with TestClient(app):
            pass
    assert no_keychain == []


def test_missing_key_file_with_existing_entries_is_key_unavailable(admin_client, monkeypatch, tmp_path):
    # The entry is encrypted with the test env key before the file source is configured.
    created = admin_client.post(
        "/api/entries", json={"secret": "JBSWY3DPEHPK3PXP", "label": "File Key", "issuer": "Test"}
    )
    assert created.status_code == 201, created.text
    no_keychain = _forbid_keychain(monkeypatch)
    key_path = tmp_path / "missing.key"
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(key_path))

    response = admin_client.post(f"/api/entries/{created.json()['id']}/code", json={})
    assert response.status_code == 503
    assert response.json()["detail"] == "KEY_UNAVAILABLE"
    with pytest.raises(KeyUnavailableError, match="不会自动生成"):
        ensure_keychain_key()
    with pytest.raises(KeyUnavailableError):
        with TestClient(app):
            pass
    assert not key_path.exists()
    assert no_keychain == []


def test_missing_key_file_with_empty_database_still_refuses(client, no_keychain, monkeypatch, tmp_path):
    key_path = tmp_path / "missing.key"
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(key_path))
    with pytest.raises(KeyUnavailableError, match="不会自动生成"):
        ensure_keychain_key()
    with pytest.raises(KeyUnavailableError):
        get_master_key()
    assert not key_path.exists()
    assert no_keychain == []


def test_systemd_credential_is_used_when_present(no_keychain, monkeypatch, tmp_path):
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    _write_key(credentials / "authtotp-master-key", 0o400)
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(credentials))
    assert master_key_file() == credentials / "authtotp-master-key"
    assert get_master_key() == FILE_KEY
    assert ensure_keychain_key() is False
    assert no_keychain == []


def test_systemd_credential_directory_without_key_is_not_a_file_source(monkeypatch, tmp_path):
    monkeypatch.delenv("AUTHTOTP_MASTER_KEY_FILE", raising=False)
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(tmp_path))
    assert master_key_file() is None


def test_explicit_key_file_takes_precedence_over_systemd_credential(no_keychain, monkeypatch, tmp_path):
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    _write_key(credentials / "authtotp-master-key", 0o400, base64.urlsafe_b64encode(b"S" * 32).decode())
    explicit = _write_key(tmp_path / "explicit.key", 0o600)
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(credentials))
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(explicit))
    assert get_master_key() == FILE_KEY


def test_malformed_key_file_is_rejected(no_keychain, monkeypatch, tmp_path):
    key_path = _write_key(tmp_path / "master.key", 0o600, "not-a-key")
    monkeypatch.setenv("AUTHTOTP_MASTER_KEY_FILE", str(key_path))
    with pytest.raises(KeyUnavailableError):
        get_master_key()
