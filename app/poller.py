"""
Background health-polling loop.

Ticks every _TICK_SECONDS and, for each enabled/non-maintenance service
instance whose ingestion_mode is 'poll', checks whether poll_interval_seconds
(scope #18 — per-service, not global) have elapsed since its last snapshot
before checking again. Each check applies the instance's own retry_count /
retry_backoff_seconds (scope #17 and #11 — Cortexarr's own polling must back
off on failure rather than hammering an already-unhealthy instance).

Connectivity failures (can't reach it / bad key) and app-reported health
issues are recorded distinctly (scope #8) via HealthResult.connectivity_ok.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import aiosqlite

from app.crypto import decrypt_str
from app.database import DB_PATH
from app.notifications import engine as alerts
from app.services import nzbget_client, radarr_client, sabnzbd_client, seerr_client, sonarr_client
from app.services.errors import ConnectivityError

log = logging.getLogger("cortexarr.poller")

# Types with a real check_health behind them — the poller only picks up
# instances of these.
_HEALTH_CLIENTS = {
    "sonarr": sonarr_client, "radarr": radarr_client, "seerr": seerr_client, "nzbget": nzbget_client,
    "sabnzbd": sabnzbd_client,
}

_TICK_SECONDS = 5
_PRUNE_EVERY_SECONDS = 3600
_DEFAULT_RETENTION_DAYS = 30


async def _get_setting(db: aiosqlite.Connection, key: str, default):
    async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return default


async def _check_one(db: aiosqlite.Connection, service: aiosqlite.Row) -> None:
    api_key = decrypt_str(service["api_key_enc"])
    retries = max(service["retry_count"], 0)
    backoff = max(service["retry_backoff_seconds"], 1)

    client = _HEALTH_CLIENTS[service["type"]]
    result = None
    last_error = ""
    for attempt in range(retries + 1):
        try:
            result = await client.check_health(service["base_url"], api_key)
            break
        except ConnectivityError as exc:
            last_error = str(exc)
            if attempt < retries:
                await asyncio.sleep(backoff * (attempt + 1))

    if result is None:
        status, connectivity_ok, summary = "unreachable", False, last_error
        await db.execute(
            "INSERT INTO health_snapshots (service_instance_id, connectivity_ok, status, detail) "
            "VALUES (?, 0, 'unreachable', ?)",
            (service["id"], json.dumps({"error": last_error})),
        )
    else:
        status, connectivity_ok, summary = result.status, result.connectivity_ok, result.detail
        await db.execute(
            "INSERT INTO health_snapshots (service_instance_id, connectivity_ok, status, detail) "
            "VALUES (?, ?, ?, ?)",
            (service["id"], int(result.connectivity_ok), result.status,
             json.dumps({"issues": result.issues, "summary": result.detail})),
        )
    await db.commit()

    # Alerting must never cost a health check, so its failures stop here.
    try:
        await alerts.process(db, service, api_key, status, connectivity_ok, summary or "")
    except Exception:
        log.exception("Alert processing failed for service %s", service["id"])


async def _prune(db: aiosqlite.Connection) -> None:
    retention_days = await _get_setting(db, "health_retention_days", _DEFAULT_RETENTION_DAYS)
    await db.execute(
        "DELETE FROM health_snapshots WHERE checked_at < datetime('now', ?)",
        (f"-{int(retention_days)} days",),
    )
    await db.commit()


async def run_forever() -> None:
    log.info("Health poller started (tick=%ss)", _TICK_SECONDS)
    last_prune = 0.0
    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                types = sorted(_HEALTH_CLIENTS)
                async with db.execute(
                    "SELECT si.*, "
                    "(SELECT checked_at FROM health_snapshots hs WHERE hs.service_instance_id = si.id "
                    " ORDER BY checked_at DESC LIMIT 1) AS last_checked_at "
                    "FROM service_instances si "
                    "WHERE si.enabled = 1 AND si.maintenance_mode = 0 AND si.ingestion_mode = 'poll' "
                    f"AND si.type IN ({', '.join('?' for _ in types)})",
                    types,
                ) as cur:
                    services = await cur.fetchall()

                try:
                    await alerts.forget_paused(db)
                except Exception:
                    log.exception("Alert cleanup for paused services failed")

                now = time.time()
                for service in services:
                    due = True
                    if service["last_checked_at"]:
                        import datetime as _dt
                        last = _dt.datetime.fromisoformat(service["last_checked_at"]).replace(tzinfo=_dt.timezone.utc)
                        elapsed = (_dt.datetime.now(_dt.timezone.utc) - last).total_seconds()
                        due = elapsed >= service["poll_interval_seconds"]
                    if due:
                        try:
                            await _check_one(db, service)
                        except Exception:
                            log.exception("Health check failed for service %s", service["id"])

                if now - last_prune > _PRUNE_EVERY_SECONDS:
                    await _prune(db)
                    last_prune = now
        except Exception:
            log.exception("Poller tick failed")

        await asyncio.sleep(_TICK_SECONDS)
