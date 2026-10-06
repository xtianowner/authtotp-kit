from __future__ import annotations

import base64
import os
import secrets
import sqlite3
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag

from .config import settings


class KeyUnavailableError(RuntimeError):
    pass


def _decode_key(raw: str) -> bytes:
    try:
        key = base64.urlsafe_b64decode(raw.encode("ascii"))
    except (ValueError, UnicodeError) as exc:
        raise KeyUnavailableError("主密钥格式无效。") from exc
    if len(key) != 32:
        raise KeyUnavailableError("主密钥必须为 32 字节。")
    return key


MASTER_KEY_FILE_ENV = "AUTHTOTP_MASTER_KEY_FILE"
SYSTEMD_CREDENTIAL_NAME = "authtotp-master-key"
_MAX_KEY_FILE_BYTES = 4096


def master_key_file() -> Path | None:
    """File-based key source: explicit env path, else a present systemd credential."""
    explicit = os.environ.get(MASTER_KEY_FILE_ENV, "").strip()
    if explicit:
        return Path(explicit).expanduser()
    credentials_directory = os.environ.get("CREDENTIALS_DIRECTORY", "").strip()
    if credentials_directory:
        candidate = Path(credentials_directory) / SYSTEMD_CREDENTIAL_NAME
        if os.path.lexists(candidate):
            return candidate
    return None


def _read_key_file(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError as exc:
        raise KeyUnavailableError(
            f"主密钥文件不存在：{path}。服务器上的主密钥必须由人工放置，服务不会自动生成新密钥。"
        ) from exc
    except OSError as exc:
        raise KeyUnavailableError(f"无法打开主密钥文件：{path}（{exc.strerror}）。") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise KeyUnavailableError(f"主密钥路径不是普通文件：{path}。")
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o077:
            raise KeyUnavailableError(
                f"主密钥文件权限过宽：{path} 当前为 {mode:04o}，group/other 不得有任何权限位；"
                "请改为 0600 或 0400 后再启动。"
            )
        raw = os.read(descriptor, _MAX_KEY_FILE_BYTES)
    finally:
        os.close(descriptor)
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise KeyUnavailableError("主密钥文件内容格式无效。") from exc
    return _decode_key(text.strip())


def get_master_key() -> bytes:
    injected = os.environ.get("AUTHTOTP_MASTER_KEY")
    if injected:
        return _decode_key(injected)

    key_file = master_key_file()
    if key_file is not None:
        return _read_key_file(key_file)

    if os.uname().sysname != "Darwin":
        raise KeyUnavailableError(
            "非 macOS 环境必须通过 AUTHTOTP_MASTER_KEY_FILE 或 systemd 凭据 "
            "$CREDENTIALS_DIRECTORY/authtotp-master-key 提供主密钥。"
        )

    account = os.environ.get("USER")
    if not account:
        raise KeyUnavailableError("无法确定当前钥匙串账户。")
    result = subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-a",
            account,
            "-s",
            settings.keychain_service,
            "-w",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise KeyUnavailableError("macOS 钥匙串中没有 AuthTOTP 主密钥。")
    return _decode_key(result.stdout.strip())


def ensure_keychain_key() -> bool:
    """Ensure a key exists in macOS Keychain. Returns True when newly created."""
    if os.environ.get("AUTHTOTP_MASTER_KEY"):
        get_master_key()
        return False
    if master_key_file() is not None:
        # File-managed keys are placed by a human; validate only, never generate.
        get_master_key()
        return False
    if os.uname().sysname != "Darwin":
        raise KeyUnavailableError("非 macOS 环境不会自动创建主密钥。")
    account = os.environ.get("USER")
    if not account:
        raise KeyUnavailableError("无法确定当前钥匙串账户。")
    existing = subprocess.run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-a",
            account,
            "-s",
            settings.keychain_service,
            "-w",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if existing.returncode == 0:
        _decode_key(existing.stdout.strip())
        return False

    if settings.database_path.exists():
        try:
            with sqlite3.connect(settings.database_path) as connection:
                has_entries = connection.execute(
                    "SELECT COUNT(*) FROM entries"
                ).fetchone()[0] > 0
        except sqlite3.Error:
            has_entries = settings.database_path.stat().st_size > 0
        if has_entries:
            raise KeyUnavailableError(
                "已有验证码数据但钥匙串主密钥缺失；为避免永久失去数据，拒绝生成新密钥。"
            )
    encoded = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    subprocess.run(
        [
            "/usr/bin/security",
            "add-generic-password",
            "-U",
            "-a",
            account,
            "-s",
            settings.keychain_service,
            "-w",
            encoded,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return True


@dataclass(frozen=True)
class EncryptedValue:
    payload: bytes


def encrypt_seed(seed: str, entry_id: str) -> bytes:
    entry_aad = f"AuthTOTP-seed:{entry_id}".encode("utf-8")
    wrap_aad = f"AuthTOTP-DEK:{entry_id}".encode("utf-8")
    data_key = AESGCM.generate_key(bit_length=256)
    seed_nonce = secrets.token_bytes(12)
    seed_ciphertext = AESGCM(data_key).encrypt(seed_nonce, seed.encode("ascii"), entry_aad)
    wrap_nonce = secrets.token_bytes(12)
    wrapped_data_key = AESGCM(get_master_key()).encrypt(wrap_nonce, data_key, wrap_aad)
    return b"AT02" + wrap_nonce + wrapped_data_key + seed_nonce + seed_ciphertext


def decrypt_seed(payload: bytes, entry_id: str) -> str:
    if payload.startswith(b"AT01") and len(payload) >= 33:
        nonce = payload[4:16]
        ciphertext = payload[16:]
        try:
            plaintext = AESGCM(get_master_key()).decrypt(
                nonce, ciphertext, entry_id.encode("utf-8")
            )
            return plaintext.decode("ascii")
        except (InvalidTag, UnicodeDecodeError) as exc:
            raise KeyUnavailableError("主密钥与验证码数据库不匹配，或密文已经损坏。") from exc
    if not payload.startswith(b"AT02") or len(payload) < 93:
        raise ValueError("不支持的密文格式。")
    wrap_nonce = payload[4:16]
    wrapped_data_key = payload[16:64]
    seed_nonce = payload[64:76]
    seed_ciphertext = payload[76:]
    entry_aad = f"AuthTOTP-seed:{entry_id}".encode("utf-8")
    wrap_aad = f"AuthTOTP-DEK:{entry_id}".encode("utf-8")
    try:
        data_key = AESGCM(get_master_key()).decrypt(wrap_nonce, wrapped_data_key, wrap_aad)
        plaintext = AESGCM(data_key).decrypt(seed_nonce, seed_ciphertext, entry_aad)
        return plaintext.decode("ascii")
    except (InvalidTag, UnicodeDecodeError) as exc:
        raise KeyUnavailableError("主密钥与验证码数据库不匹配，或密文已经损坏。") from exc
