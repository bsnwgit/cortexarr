"""
Sends one message through one notification channel (email / webhook / ntfy /
SMS) using the global channel config in settings (scope #3), plus any extra
targets — the per-user layer (scope #13) — the caller passes in.

Shared by the Settings page's "Send test" (scope #7) and real alerts, so a
channel that passes its test is the same code path that sends alerts.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Iterable

import aiosqlite

log = logging.getLogger("cortexarr.notifications")

CHANNELS = ("email", "webhook", "ntfy", "sms")


@dataclass(frozen=True)
class Message:
    subject: str       # email subject line
    email_body: str
    title: str         # ntfy notification title
    text: str          # webhook / ntfy / SMS body


async def _get(db: aiosqlite.Connection, key: str) -> Any:
    async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
        row = await cur.fetchone()
    return json.loads(row[0]) if row else None


def _merge(base: Iterable[str], extra: Iterable[str]) -> list[str]:
    out: list[str] = []
    for t in [*base, *extra]:
        t = (t or "").strip()
        if t and t not in out:
            out.append(t)
    return out


async def send(
    db: aiosqlite.Connection, channel: str, msg: Message,
    extra_targets: Iterable[str] = (), first_sms_only: bool = False,
) -> dict[str, str]:
    """Returns {"status": sent | skipped | failed, "detail": ...}."""
    from app.api.settings import read_secret

    extra = list(extra_targets)
    try:
        if channel == "email":
            if not await _get(db, "notify_email_enabled"):
                return {"status": "skipped", "detail": "Email is not enabled"}
            host = await _get(db, "notify_email_smtp_host") or ""
            port = await _get(db, "notify_email_smtp_port") or 587
            use_tls = await _get(db, "notify_email_smtp_tls")
            use_tls = True if use_tls is None else use_tls
            username = await _get(db, "notify_email_username") or ""
            password = await read_secret(db, "notify_email_password")
            from_addr = await _get(db, "notify_email_from") or "cortexarr@localhost"
            to_addrs = _merge(await _get(db, "notify_email_default_to") or [], extra)
            if not host or not to_addrs:
                return {"status": "skipped", "detail": "SMTP host or recipient list not configured"}
            import aiosmtplib
            from email.mime.text import MIMEText
            mime = MIMEText(msg.email_body, "plain")
            mime["Subject"] = msg.subject
            mime["From"] = from_addr
            mime["To"] = ", ".join(to_addrs)
            await aiosmtplib.send(
                mime, hostname=host, port=int(port), use_tls=bool(use_tls),
                username=username or None, password=password or None,
            )
            return {"status": "sent", "detail": f"Email sent to {', '.join(to_addrs)}"}

        if channel == "webhook":
            if not await _get(db, "notify_webhook_enabled"):
                return {"status": "skipped", "detail": "Webhook is not enabled"}
            urls = _merge([await _get(db, "notify_webhook_url") or ""], extra)
            method = await _get(db, "notify_webhook_method") or "POST"
            headers = await _get(db, "notify_webhook_headers") or {}
            if not urls:
                return {"status": "skipped", "detail": "No webhook URL configured"}
            import httpx
            codes = []
            async with httpx.AsyncClient() as client:
                for url in urls:
                    resp = await client.request(method.upper(), url, json={"text": msg.text}, headers=headers, timeout=10)
                    if resp.status_code >= 300:
                        return {"status": "failed", "detail": f"Webhook returned HTTP {resp.status_code}: {resp.text[:200]}"}
                    codes.append(str(resp.status_code))
            return {"status": "sent", "detail": f"Webhook returned HTTP {', '.join(codes)}"}

        if channel == "ntfy":
            if not await _get(db, "notify_ntfy_enabled"):
                return {"status": "skipped", "detail": "ntfy is not enabled"}
            server = (await _get(db, "notify_ntfy_server") or "https://ntfy.sh").rstrip("/")
            topics = _merge([await _get(db, "notify_ntfy_topic") or ""], extra)
            token = await read_secret(db, "notify_ntfy_auth_token")
            if not topics:
                return {"status": "skipped", "detail": "No ntfy topic configured"}
            import httpx
            headers = {"Title": msg.title}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            codes = []
            async with httpx.AsyncClient() as client:
                for topic in topics:
                    resp = await client.post(f"{server}/{topic}", content=msg.text.encode(), headers=headers, timeout=10)
                    if resp.status_code >= 300:
                        return {"status": "failed", "detail": f"ntfy returned HTTP {resp.status_code}: {resp.text[:200]}"}
                    codes.append(str(resp.status_code))
            return {"status": "sent", "detail": f"ntfy returned HTTP {', '.join(codes)}"}

        if channel == "sms":
            if not await _get(db, "notify_sms_enabled"):
                return {"status": "skipped", "detail": "SMS is not enabled"}
            sid = await _get(db, "notify_sms_twilio_account_sid") or ""
            auth = await read_secret(db, "notify_sms_twilio_auth_token")
            from_number = await _get(db, "notify_sms_twilio_from_number") or ""
            to_numbers = _merge(await _get(db, "notify_sms_default_to") or [], extra)
            if not sid or not auth or not from_number or not to_numbers:
                return {"status": "skipped", "detail": "Twilio not fully configured"}
            if first_sms_only:
                to_numbers = to_numbers[:1]
            import httpx
            async with httpx.AsyncClient() as client:
                for number in to_numbers:
                    resp = await client.post(
                        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                        auth=(sid, auth),
                        data={"From": from_number, "To": number, "Body": msg.text},
                        timeout=10,
                    )
                    if resp.status_code >= 300:
                        return {"status": "failed", "detail": f"Twilio returned HTTP {resp.status_code}: {resp.text[:200]}"}
            return {"status": "sent", "detail": f"SMS sent to {', '.join(to_numbers)}"}

        return {"status": "failed", "detail": f"Unknown channel: {channel}"}
    except Exception:
        log.exception("notification send through %s failed", channel)
        return {"status": "failed", "detail": "Request failed — see the app log for detail"}
