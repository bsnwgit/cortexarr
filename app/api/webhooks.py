"""
/api/webhooks/{service_id}/{token} — Sonarr/Radarr push their own events
here (scope: accept Sonarr/Radarr webhooks rather than only polling them).
Authenticated by a per-service token embedded in the URL itself, since
Sonarr/Radarr's webhook connection can't reliably be made to send a custom
Authorization header across every version — there's no session, so no
CurrentUser dependency here.

This only ever reacts sooner, never replaces the background poll: Sonarr's
webhook has no event for "an item has been sitting in the queue too long",
so app/poller.py keeps checking every service's queue on its own schedule
regardless of ingestion_mode. A HealthIssue/HealthRestored webhook just
means the health side of that same check doesn't have to wait for the next
tick — it's recorded and alerted on immediately, the same way a poll result
would be.
"""
from __future__ import annotations

import hmac
import json
import logging

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.crypto import decrypt_str
from app.database import get_db
from app.notifications import engine as alerts

router = APIRouter()
log = logging.getLogger("cortexarr.webhooks")

_LEVELS = {"warning": "warning", "error": "error"}
# Grab/Download/Rename/SeriesDelete/etc: real events, but not our health
# signal — acknowledged so Sonarr/Radarr doesn't see them as failed
# deliveries, without doing anything else with them.
_HEALTH_EVENTS = {"HealthIssue", "HealthRestored"}


@router.post("/{service_id}/{token}")
async def receive_webhook(service_id: int, token: str, request: Request, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT * FROM service_instances WHERE id = ? AND type IN ('sonarr', 'radarr')", (service_id,),
    ) as cur:
        service = await cur.fetchone()
    # Same "not found rather than forbidden" shape as a bad API token —
    # nothing here should let a guess confirm a service id exists.
    if not service or not service["webhook_token"] or not hmac.compare_digest(service["webhook_token"], token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON")
    event_type = payload.get("eventType", "")

    if event_type == "Test":
        return {"ok": True}
    if event_type not in _HEALTH_EVENTS:
        return {"ok": True}

    if event_type == "HealthRestored":
        health_status, summary = "ok", ""
    else:
        level = str(payload.get("level") or "warning").lower()
        health_status = _LEVELS.get(level, "warning")
        summary = payload.get("message") or ""
    connectivity_ok = True  # it just reached us, so it's up

    await db.execute(
        "INSERT INTO health_snapshots (service_instance_id, connectivity_ok, status, detail) VALUES (?, 1, ?, ?)",
        (service_id, health_status, json.dumps({"issues": [summary] if summary else [], "summary": summary, "source": "webhook"})),
    )
    await db.commit()

    api_key = decrypt_str(service["api_key_enc"])
    try:
        await alerts.process(db, service, api_key, health_status, connectivity_ok, summary)
    except Exception:
        log.exception("Alert processing failed for webhook on service %s", service_id)
    return {"ok": True}
