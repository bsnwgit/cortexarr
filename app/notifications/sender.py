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
    extra_targets: Iterable[str] = (), first_sms_only: bool = False, only_extra: bool = False,
) -> dict[str, str]:
    """Returns {"status": sent | skipped | failed, "detail": ...}.
    only_extra sends to extra_targets alone, not the admin's default
    recipients — a user testing their own address."""
    from app.api.settings import read_secret

    extra = list(extra_targets)

    async def base(key: str, default: Any) -> Any:
        return default if only_extra else (await _get(db, key) or default)
    try:
        if channel == "email":
            if not await _get(db, "notify_email_enabled"):
                return {"status": "skipped", "detail": "Email is turned off — tick it to use it"}
            host = await _get(db, "notify_email_smtp_host") or ""
            port = await _get(db, "notify_email_smtp_port") or 587
            use_tls = await _get(db, "notify_email_smtp_tls")
            use_tls = True if use_tls is None else use_tls
            username = await _get(db, "notify_email_username") or ""
            password = await read_secret(db, "notify_email_password")
            from_addr = await _get(db, "notify_email_from") or "cortexarr@localhost"
            to_addrs = _merge(await base("notify_email_default_to", []), extra)
            if not host or not to_addrs:
                return {"status": "skipped", "detail": "Fill in the SMTP host and who to send to first"}
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
            return {"status": "sent", "detail": f"Email sent to {', '.join(to_addrs)} — check the inbox"}

        if channel == "webhook":
            if not await _get(db, "notify_webhook_enabled"):
                return {"status": "skipped", "detail": "Webhook is turned off — tick it to use it"}
            urls = _merge([await base("notify_webhook_url", "")], extra)
            method = await _get(db, "notify_webhook_method") or "POST"
            headers = await _get(db, "notify_webhook_headers") or {}
            if not urls:
                return {"status": "skipped", "detail": "Paste the webhook URL first"}
            import httpx
            async with httpx.AsyncClient() as client:
                for url in urls:
                    resp = await client.request(method.upper(), url, json={"text": msg.text}, headers=headers, timeout=10)
                    if resp.status_code >= 300:
                        return {"status": "failed", "detail": f"The webhook refused it (error {resp.status_code}) — check the URL is right and still active"}
            return {"status": "sent", "detail": "Delivered — check your Slack/Discord channel"}

        if channel == "ntfy":
            if not await _get(db, "notify_ntfy_enabled"):
                return {"status": "skipped", "detail": "ntfy is turned off — tick it to use it"}
            server = (await _get(db, "notify_ntfy_server") or "https://ntfy.sh").rstrip("/")
            topics = _merge([await base("notify_ntfy_topic", "")], extra)
            token = await read_secret(db, "notify_ntfy_auth_token")
            if not topics:
                return {"status": "skipped", "detail": "Enter the ntfy topic first"}
            import httpx
            headers = {"Title": msg.title}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            async with httpx.AsyncClient() as client:
                for topic in topics:
                    resp = await client.post(f"{server}/{topic}", content=msg.text.encode(), headers=headers, timeout=10)
                    if resp.status_code >= 300:
                        return {"status": "failed", "detail": f"ntfy refused it (error {resp.status_code}) — check the server, topic and token"}
            return {"status": "sent", "detail": f"Delivered to ntfy topic {', '.join(topics)} — check the app"}

        if channel == "sms":
            if not await _get(db, "notify_sms_enabled"):
                return {"status": "skipped", "detail": "SMS is turned off — tick it to use it"}
            sid = await _get(db, "notify_sms_twilio_account_sid") or ""
            auth = await read_secret(db, "notify_sms_twilio_auth_token")
            from_number = await _get(db, "notify_sms_twilio_from_number") or ""
            to_numbers = _merge(await base("notify_sms_default_to", []), extra)
            if not sid or not auth or not from_number or not to_numbers:
                return {"status": "skipped", "detail": "Fill in the Twilio account, token, from number and who to text first"}
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
                        return {"status": "failed", "detail": f"Twilio refused it (error {resp.status_code}) — check the account details and numbers"}
            return {"status": "sent", "detail": f"Texted {', '.join(to_numbers)} — check the phone"}

        return {"status": "failed", "detail": f"Unknown channel: {channel}"}
    except Exception:
        log.exception("notification send through %s failed", channel)
        return {"status": "failed", "detail": "Couldn't reach it — check the address and that it's up (details in the app log)"}
