"""
GET/PUT /api/settings — global runtime settings (scope item #13's "global"
layer): notification provider config, health-check retention, batching, and
self-update mode. Per-user notification preferences live in
/api/users/me/notifications instead (app/api/users.py).

All settings are stored as JSON values in the SQLite settings table.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import audit
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

log = logging.getLogger("cortexarr.settings")

router = APIRouter()

DEFAULTS: dict[str, Any] = {
    # Email (generic SMTP — works with any provider, nothing to integrate against)
    "notify_email_enabled": False,
    "notify_email_smtp_host": "",
    "notify_email_smtp_port": 587,
    "notify_email_smtp_tls": True,
    "notify_email_username": "",
    "notify_email_password": "",
    "notify_email_from": "",
    "notify_email_default_to": [],

    # Generic incoming webhook (Slack/Discord both consume this shape)
    "notify_webhook_enabled": False,
    "notify_webhook_url": "",
    "notify_webhook_method": "POST",
    "notify_webhook_headers": {},

    # Push via ntfy (scope item #3, resolved: ntfy over Pushover)
    "notify_ntfy_enabled": False,
    "notify_ntfy_server": "https://ntfy.sh",
    "notify_ntfy_topic": "",
    "notify_ntfy_auth_token": "",

    # SMS via Twilio (scope item #3, resolved default)
    "notify_sms_enabled": False,
    "notify_sms_twilio_account_sid": "",
    "notify_sms_twilio_auth_token": "",
    "notify_sms_twilio_from_number": "",
    "notify_sms_default_to": [],

    # Notification batching/digest (scope #12) — 0 = send immediately, no batching
    "notify_batch_window_minutes": 0,

    # Health-check history retention (scope #14)
    "health_retention_days": 30,

    # Time zone for every time shown (web UI, alert messages) — an IANA name
    # like "America/New_York". Empty = each viewer's browser zone in the web
    # UI, and UTC in alert messages.
    "timezone": "",

    # Self-update (scope #16)
    "self_update_mode": "manual",       # 'manual' | 'auto'
    "self_update_window_start": "02:00",
    "self_update_window_end": "04:00",
}

_MASK = "••••••••"
_SECRET_KEYS = frozenset({
    "notify_email_password", "notify_ntfy_auth_token", "notify_sms_twilio_auth_token",
})
_ENCRYPTED_KEYS = _SECRET_KEYS  # provider credentials — Fernet at rest, not just masked in responses


def _validate(key: str, value: Any) -> None:
    if key == "timezone" and value:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(str(value))
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(status_code=400, detail=f"Unknown time zone: {value}")


def _store_value(key: str, value: Any) -> Any:
    if key in _ENCRYPTED_KEYS and isinstance(value, str) and value:
        from app.crypto import encrypt_str
        return encrypt_str(value)
    return value


async def read_secret(db: aiosqlite.Connection, key: str) -> str:
    async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    if not row or not row[0]:
        return ""
    try:
        stored = json.loads(row[0])
    except (json.JSONDecodeError, TypeError, ValueError):
        stored = row[0]
    if not isinstance(stored, str) or not stored:
        return ""
    from app.crypto import decrypt_str
    return decrypt_str(stored)


async def _ensure_defaults(db: aiosqlite.Connection) -> None:
    for key, value in DEFAULTS.items():
        await db.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
            (key, json.dumps(value)),
        )
    await db.commit()


@router.get("/")
async def get_all_settings(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    await _ensure_defaults(db)
    async with db.execute("SELECT key, value FROM settings") as cur:
        rows = await cur.fetchall()
    result = {r[0]: json.loads(r[1]) for r in rows}
    for secret_key in _SECRET_KEYS:
        if result.get(secret_key):
            result[secret_key] = _MASK
    return result


class SettingUpdate(BaseModel):
    value: Any


@router.put("/{key}")
async def update_setting(key: str, body: SettingUpdate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if key not in DEFAULTS:
        raise HTTPException(status_code=400, detail=f"Unknown setting key: {key}")
    if key in _SECRET_KEYS and body.value == _MASK:
        return {"key": key, "updated": False, "skipped": "mask value"}
    _validate(key, body.value)

    await db.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, json.dumps(_store_value(key, body.value))),
    )
    await db.commit()
    await audit.record(db, user=admin, action="setting.update", target_type="setting", target_id=key,
                        detail={} if key in _SECRET_KEYS else {"value": body.value})
    return {"key": key, "updated": True}


@router.post("/bulk")
async def bulk_update(updates: dict[str, Any], admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    unknown = [k for k in updates if k not in DEFAULTS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown keys: {unknown}")
    for key, value in updates.items():
        _validate(key, value)

    skipped = []
    for key, value in updates.items():
        if key in _SECRET_KEYS and value == _MASK:
            skipped.append(key)
            continue
        await db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(_store_value(key, value))),
        )
    await db.commit()
    written = [k for k in updates if k not in skipped]
    await audit.record(db, user=admin, action="setting.bulk_update", target_type="setting",
                        detail={"keys": written})
    return {"updated": written, "skipped": skipped}


@router.get("/update-status")
async def get_update_status(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """What self-update (scope #16) knows right now: current version, the
    latest GitHub release if newer, and the last apply attempt. Read-only —
    the actual check runs on its own schedule in app/self_update.py."""
    from app import self_update
    return await self_update.status(db)


@router.post("/update-check")
async def force_update_check(admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Admin-triggered "check now", instead of waiting for the hourly poll."""
    from app import self_update
    result = await self_update.check_latest(db)
    await audit.record(db, user=admin, action="self_update.check", target_type="system",
                        detail={"available": result.get("update_available")})
    return result


class TestNotificationRequest(BaseModel):
    channel: str  # 'email' | 'webhook' | 'ntfy' | 'sms'


@router.post("/test-notification")
async def test_notification(body: TestNotificationRequest, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Fire a test alert through a configured channel (scope #7) so a
    misconfigured provider is caught immediately, not discovered when a
    real alert silently fails to arrive."""
    channel = body.channel
    valid = {"email", "webhook", "ntfy", "sms"}
    if channel not in valid:
        raise HTTPException(status_code=400, detail=f"Unknown channel: {channel}. Valid: {sorted(valid)}")

    from app.notifications.sender import Message, send

    test_msg = "Cortexarr test notification — your configuration is working correctly."
    return await send(db, channel, Message(
        subject="[Cortexarr Test] Notification check",
        email_body=f"Cortexarr Test Notification\n\n{test_msg}",
        title="Cortexarr Test",
        text=test_msg,
    ), first_sms_only=True)
