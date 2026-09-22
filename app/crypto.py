"""
Fernet-based encryption for secrets at rest: monitored-service API keys
(service_instances.api_key_enc) and notification-provider secrets stored in
the settings table (SMTP password, ntfy/webhook auth, Twilio auth token).

credential_key is generated once (Fernet.generate_key()) and written to
config.yaml, the same way secret_key is handled for JWT signing. Encrypted
values are never returned by any API response in full — only masked, or
decrypted in-process to make the actual outbound call.
"""
from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


def _fernet() -> Fernet:
    settings = get_settings()
    key = settings.credential_key
    if not key:
        raise RuntimeError(
            "credential_key is not configured — set it in config.yaml "
            "(generate with: python3 -c \"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\")"
        )
    return Fernet(key.encode())


def encrypt_str(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: str | None) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""
