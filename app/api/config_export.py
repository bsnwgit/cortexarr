"""
/api/config/* — export and import the service list and notification
configuration (scope #10), so a setup can be backed up or moved. Not the
app's SQLite data wholesale — no health history, audit log, users or alert
log travels with it.

Import reuses the same routes the web UI uses to create each service or
rule, so type detection, validation and audit logging all happen exactly as
they would by hand. A service or rule whose name already exists is left
alone rather than duplicated, so re-importing the same file twice is safe.

Including credentials in the export always requires a password: the file
that comes back is a password-encrypted envelope (PBKDF2-HMAC-SHA256 ->
Fernet), not plain JSON with secrets sitting in it. Encryption is optional,
same mechanism, for anyone who wants it on a credentials-free export too.
"""
from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
from typing import Any, Optional

import aiosqlite
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, ValidationError

from app import audit
from app.api import alerts as alerts_api
from app.api import services as services_api
from app.api import settings as settings_api
from app.crypto import decrypt_str
from app.database import get_db
from app.dependencies import AdminUser

router = APIRouter()

FORMAT_VERSION = 1
ENCRYPTED_FORMAT_VERSION = 1
_KDF_ITERATIONS = 390_000  # OWASP's 2023 minimum for PBKDF2-HMAC-SHA256
_MIN_PASSPHRASE = 8


def _derive_fernet(passphrase: str, salt: bytes, iterations: int) -> Fernet:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(passphrase.encode())))


def _encrypt(payload: dict, passphrase: str) -> dict:
    salt = os.urandom(16)
    ciphertext = _derive_fernet(passphrase, salt, _KDF_ITERATIONS).encrypt(json.dumps(payload).encode())
    return {
        "cortexarr_encrypted_export": ENCRYPTED_FORMAT_VERSION,
        "kdf": "pbkdf2-sha256",
        "iterations": _KDF_ITERATIONS,
        "salt": base64.b64encode(salt).decode(),
        "ciphertext": ciphertext.decode(),
    }


def _decrypt(envelope: dict, passphrase: str) -> dict:
    try:
        salt = base64.b64decode(envelope["salt"])
        fernet = _derive_fernet(passphrase, salt, int(envelope["iterations"]))
        return json.loads(fernet.decrypt(envelope["ciphertext"].encode()))
    except (InvalidToken, KeyError, ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Wrong password, or not a Cortexarr backup file")

# Channel config only — not retention/timezone/self-update, which are
# per-instance operational choices rather than something to carry to a
# fresh install.
_SETTINGS_KEYS = [
    "notify_email_enabled", "notify_email_smtp_host", "notify_email_smtp_port", "notify_email_smtp_tls",
    "notify_email_username", "notify_email_password", "notify_email_from", "notify_email_default_to",
    "notify_webhook_enabled", "notify_webhook_url", "notify_webhook_method", "notify_webhook_headers",
    "notify_ntfy_enabled", "notify_ntfy_server", "notify_ntfy_topic", "notify_ntfy_auth_token",
    "notify_sms_enabled", "notify_sms_twilio_account_sid", "notify_sms_twilio_auth_token",
    "notify_sms_twilio_from_number", "notify_sms_default_to",
    "notify_batch_window_minutes",
]


class ExportRequest(BaseModel):
    include_credentials: bool = False
    passphrase: Optional[str] = Field(default=None, max_length=200)


@router.post("/export")
async def export_config(body: ExportRequest, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.include_credentials and not body.passphrase:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="A password is required to export with credentials included")
    if body.passphrase and len(body.passphrase) < _MIN_PASSPHRASE:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Password must be at least {_MIN_PASSPHRASE} characters")

    async with db.execute(
        "SELECT id, name, type, base_url, api_key_enc, poll_interval_seconds, retry_count, "
        "retry_backoff_seconds, ingestion_mode FROM service_instances ORDER BY name",
    ) as cur:
        service_rows = await cur.fetchall()
    name_by_id = {r["id"]: r["name"] for r in service_rows}
    services = [{
        "name": r["name"], "type": r["type"], "base_url": r["base_url"],
        "api_key": decrypt_str(r["api_key_enc"]) if body.include_credentials and r["api_key_enc"] else "",
        "poll_interval_seconds": r["poll_interval_seconds"], "retry_count": r["retry_count"],
        "retry_backoff_seconds": r["retry_backoff_seconds"], "ingestion_mode": r["ingestion_mode"],
    } for r in service_rows]

    all_settings = await settings_api.get_all_settings(admin, db)
    notification_settings: dict[str, Any] = {}
    for key in _SETTINGS_KEYS:
        if key in settings_api._SECRET_KEYS:
            notification_settings[key] = await settings_api.read_secret(db, key) if body.include_credentials else ""
        else:
            notification_settings[key] = all_settings.get(key, settings_api.DEFAULTS.get(key))

    async with db.execute("SELECT * FROM alert_rules ORDER BY name") as cur:
        rule_rows = await cur.fetchall()
    alert_rules = [{
        "name": r["name"], "enabled": bool(r["enabled"]), "event": r["event"],
        "service_name": name_by_id.get(r["service_id"]),
        "threshold_minutes": r["threshold_minutes"], "repeat_minutes": r["repeat_minutes"],
        "channels": json.loads(r["channels"] or "[]"), "notify_resolved": bool(r["notify_resolved"]),
    } for r in rule_rows]

    await audit.record(db, user=admin, action="config.export", target_type="config",
                       detail={"include_credentials": body.include_credentials, "encrypted": bool(body.passphrase),
                               "services": len(services), "alert_rules": len(alert_rules)})
    result = {
        "cortexarr_config_export": FORMAT_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "includes_credentials": body.include_credentials,
        "services": services,
        "notification_settings": notification_settings,
        "alert_rules": alert_rules,
    }
    return _encrypt(result, body.passphrase) if body.passphrase else result


class ImportServiceEntry(BaseModel):
    name: str
    type: str
    base_url: str
    api_key: str = ""
    poll_interval_seconds: int = 60
    retry_count: int = 3
    retry_backoff_seconds: int = 5
    ingestion_mode: str = "poll"


class ImportRuleEntry(BaseModel):
    name: str
    enabled: bool = True
    event: str
    service_name: Optional[str] = None
    threshold_minutes: int = 0
    repeat_minutes: int = 0
    channels: list[str] = Field(default_factory=list)
    notify_resolved: bool = True


class ImportRequest(BaseModel):
    services: list[ImportServiceEntry] = Field(default_factory=list)
    notification_settings: dict[str, Any] = Field(default_factory=dict)
    alert_rules: list[ImportRuleEntry] = Field(default_factory=list)
    # Present only for an encrypted export — decrypted into the three
    # fields above before anything else runs. The fields above are
    # ignored (and normally empty) when this is set.
    encrypted: Optional[dict[str, Any]] = None
    passphrase: Optional[str] = None


@router.post("/import")
async def import_config(body: ImportRequest, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.encrypted:
        if not body.passphrase:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A password is required for this file")
        decrypted = _decrypt(body.encrypted, body.passphrase)
        try:
            body = ImportRequest(
                services=[ImportServiceEntry(**s) for s in decrypted.get("services", [])],
                notification_settings=decrypted.get("notification_settings", {}),
                alert_rules=[ImportRuleEntry(**r) for r in decrypted.get("alert_rules", [])],
            )
        except ValidationError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Decrypted, but the contents aren't a valid backup: {exc.errors()[0]['msg']}")

    async with db.execute("SELECT id, name FROM service_instances") as cur:
        service_id_by_name = {r["name"]: r["id"] for r in await cur.fetchall()}

    services_added, services_skipped, services_failed = [], [], []
    for entry in body.services:
        if entry.name in service_id_by_name:
            services_skipped.append(entry.name)
            continue
        try:
            created = await services_api.create_service(services_api.ServiceCreate(**entry.model_dump()), admin, db)
        except HTTPException as exc:
            services_failed.append({"name": entry.name, "detail": str(exc.detail)})
            continue
        service_id_by_name[entry.name] = created["id"]
        services_added.append(entry.name)

    settings_applied: list[str] = []
    if body.notification_settings:
        # A credentials-excluded export carries "" for each secret — never
        # let that blank out a real one already configured here.
        updates = {k: v for k, v in body.notification_settings.items()
                   if k in settings_api.DEFAULTS and not (k in settings_api._SECRET_KEYS and not v)}
        if updates:
            await settings_api.bulk_update(updates, admin, db)
            settings_applied = list(updates)

    async with db.execute("SELECT name FROM alert_rules") as cur:
        existing_rule_names = {r["name"] for r in await cur.fetchall()}
    rules_added, rules_skipped, rules_failed = [], [], []
    for entry in body.alert_rules:
        if entry.name in existing_rule_names:
            rules_skipped.append(entry.name)
            continue
        service_id = None
        if entry.service_name:
            service_id = service_id_by_name.get(entry.service_name)
            if service_id is None:
                rules_skipped.append(f"{entry.name} (no service named '{entry.service_name}')")
                continue
        try:
            rule_in = alerts_api.RuleIn(**{**entry.model_dump(exclude={"service_name"}), "service_id": service_id})
            await alerts_api.create_rule(rule_in, admin, db)
        except (HTTPException, ValidationError) as exc:
            detail = str(exc.errors()[0]["msg"]) if isinstance(exc, ValidationError) else str(exc.detail)
            rules_failed.append({"name": entry.name, "detail": detail})
            continue
        existing_rule_names.add(entry.name)
        rules_added.append(entry.name)

    await audit.record(db, user=admin, action="config.import", target_type="config",
                       detail={"services_added": len(services_added), "services_skipped": len(services_skipped),
                               "services_failed": len(services_failed), "rules_added": len(rules_added),
                               "rules_skipped": len(rules_skipped), "rules_failed": len(rules_failed),
                               "settings_applied": len(settings_applied)})
    return {
        "services_added": services_added, "services_skipped": services_skipped, "services_failed": services_failed,
        "settings_applied": settings_applied,
        "rules_added": rules_added, "rules_skipped": rules_skipped, "rules_failed": rules_failed,
    }
