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
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends

from app.crypto import decrypt_str
from app.database import get_db
from app.dependencies import CurrentUser
from app.services import nzbget_client, radarr_client, sabnzbd_client, seerr_client, sonarr_client
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()

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
    try:
        out["stats"] = await asyncio.wait_for(fn(row["base_url"], decrypt_str(row["api_key_enc"])), timeout=30)
        out["ok"] = True
    except (ConnectivityError, ServiceApiError) as exc:
        out["error"] = str(exc)
    except asyncio.TimeoutError:
        out["error"] = "Timed out"
    return out


@router.get("/")
async def all_stats(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM service_instances WHERE enabled = 1 ORDER BY name") as cur:
        rows = await cur.fetchall()
    return {"services": await asyncio.gather(*(_one(r) for r in rows))}
