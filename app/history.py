"""
Request-completion recording for History and trends (scope #4).

Uptime and alert trends need nothing new — they're aggregated straight from
health_snapshots and alert_log (see app/api/history.py). Request throughput
is different: tracking.py computes each request's stage live, on demand,
and doesn't remember when a request crossed into 'available'. This module
periodically scans for that transition and records it once, so "requests
completed per week" and "average time to available" have something to
report on.

available_at is when this scan noticed, not the exact moment Sonarr/Radarr
finished importing — accurate to _INTERVAL_SECONDS, not to the second, same
caveat "stalled" alerting already carries. Nothing is backfilled for
requests that became available before this existed.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging

import aiosqlite

from app.database import DB_PATH

log = logging.getLogger("cortexarr.history")

_INTERVAL_SECONDS = 300


async def _seerr_ids(db: aiosqlite.Connection) -> list[int]:
    async with db.execute(
        "SELECT id FROM service_instances WHERE type = 'seerr' AND enabled = 1 AND maintenance_mode = 0",
    ) as cur:
        return [row[0] for row in await cur.fetchall()]


def _duration_seconds(requested_at: str | None, available_at: dt.datetime) -> int | None:
    if not requested_at:
        return None
    try:
        requested = dt.datetime.fromisoformat(requested_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if requested.tzinfo is None:
        requested = requested.replace(tzinfo=dt.timezone.utc)
    return max(0, int((available_at - requested).total_seconds()))


async def record_completions(db: aiosqlite.Connection) -> int:
    """Record any request that's reached 'available' and isn't already in
    request_history. Returns how many were newly recorded."""
    from app import tracking

    recorded = 0
    now = dt.datetime.now(dt.timezone.utc)
    for seerr_id in await _seerr_ids(db):
        try:
            result = await tracking.track(db, seerr_id)
        except Exception:
            log.exception("Tracking fetch failed for Seerr instance %s", seerr_id)
            continue
        for r in result["requests"]:
            if r["stage"] != "available":
                continue
            duration = _duration_seconds(r.get("requested_at"), now)
            cur = await db.execute(
                "INSERT OR IGNORE INTO request_history "
                "(seerr_service_id, request_id, title, media_type, is_4k, requested_at, available_at, duration_seconds) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (seerr_id, r["request_id"], r.get("title") or "", r.get("media_type") or "",
                 int(bool(r.get("is_4k"))), r.get("requested_at"), now.isoformat(), duration),
            )
            if cur.rowcount:
                recorded += 1
    if recorded:
        await db.commit()
    return recorded


async def run_forever() -> None:
    log.info("Request-history scan started (every %ss)", _INTERVAL_SECONDS)
    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                n = await record_completions(db)
                if n:
                    log.info("Recorded %d newly-completed request(s)", n)
        except Exception:
            log.exception("Request-history scan failed")
        await asyncio.sleep(_INTERVAL_SECONDS)
