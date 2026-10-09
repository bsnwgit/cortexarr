"""
GET /api/stats — the Status page: what every enabled service says about
itself, fetched live (not cached, not stored) and all at once. Each service
answers on its own, so one unreachable app shows an error row instead of
failing the page. Sonarr/Radarr report system info, disk, queue and
recent grab/import/fail counts; NZBGet and SABnzbd report per news server
data and article statistics; Seerr reports request counts.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from app.crypto import decrypt_str
from app.database import get_db
from app.dependencies import CurrentUser
from app.services import nzbget_client, radarr_client, sabnzbd_client, seerr_client, sonarr_client
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()

# The numbers are big reads (a whole library, a thousand history rows) that
# barely change minute to minute, so a revisit inside this window answers
# from memory. The page's refresh button asks for a fresh read.
_CACHE_SECONDS = 60
_cache: dict[int, tuple[float, dict[str, Any]]] = {}

_CLIENTS = {
    "sonarr": sonarr_client, "radarr": radarr_client, "seerr": seerr_client,
    "nzbget": nzbget_client, "sabnzbd": sabnzbd_client,
}


async def _one(row: aiosqlite.Row) -> dict[str, Any]:
    out: dict[str, Any] = {"service_id": row["id"], "name": row["name"], "type": row["type"], "ok": False}
    client = _CLIENTS.get(row["type"])
    fn = getattr(client, "get_stats", None)
    if fn is None:
        out["error"] = "No statistics for this service type"
        return out
    started = time.monotonic()
    try:
        out["stats"] = await asyncio.wait_for(fn(row["base_url"], decrypt_str(row["api_key_enc"])), timeout=75)
        out["ok"] = True
    except (ConnectivityError, ServiceApiError) as exc:
        # An httpx timeout carries no message; say what happened instead of nothing.
        out["error"] = str(exc) or "No answer — the service timed out"
    except asyncio.TimeoutError:
        out["error"] = "No answer within 75 seconds"
    out["took_ms"] = int((time.monotonic() - started) * 1000)
    return out


@router.get("/")
async def all_stats(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM service_instances WHERE enabled = 1 ORDER BY name") as cur:
        rows = await cur.fetchall()
    return {"services": await asyncio.gather(*(_one(r) for r in rows))}


@router.get("/{service_id}")
async def one_stats(
    service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), fresh: bool = False,
):
    """One service on its own, so the Status page can show each as it
    arrives instead of waiting on the slowest."""
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    hit = _cache.get(service_id)
    if hit and not fresh and time.monotonic() - hit[0] < _CACHE_SECONDS:
        return {**hit[1], "cached": True}
    result = await _one(row)
    if result["ok"]:
        _cache[service_id] = (time.monotonic(), result)
    return result
