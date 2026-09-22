"""
GET /api/status — public, unauthenticated, read-only summary (Positioning
decision: "public status API from day one", so Cortexarr can be embedded in
third-party homelab dashboards like Homepage/Homarr). No secrets, no
internal URLs — just enough to render a widget.
"""
from __future__ import annotations

import json

import aiosqlite
from fastapi import APIRouter, Depends

from app.database import get_db

router = APIRouter()


@router.get("/")
async def status_summary(db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT si.id, si.name, si.type, si.enabled, si.maintenance_mode, "
        "(SELECT status FROM health_snapshots hs WHERE hs.service_instance_id = si.id "
        " ORDER BY checked_at DESC LIMIT 1) AS status, "
        "(SELECT connectivity_ok FROM health_snapshots hs WHERE hs.service_instance_id = si.id "
        " ORDER BY checked_at DESC LIMIT 1) AS connectivity_ok, "
        "(SELECT checked_at FROM health_snapshots hs WHERE hs.service_instance_id = si.id "
        " ORDER BY checked_at DESC LIMIT 1) AS checked_at "
        "FROM service_instances si ORDER BY si.name"
    ) as cur:
        rows = await cur.fetchall()

    services = []
    overall = "ok"
    for r in rows:
        d = dict(r)
        d["enabled"] = bool(d["enabled"])
        d["maintenance_mode"] = bool(d["maintenance_mode"])
        d["connectivity_ok"] = bool(d["connectivity_ok"]) if d["connectivity_ok"] is not None else None
        if d["enabled"] and not d["maintenance_mode"]:
            if d["status"] in ("error", "unreachable"):
                overall = "error"
            elif d["status"] == "warning" and overall == "ok":
                overall = "warning"
        services.append(d)

    return {"overall": overall, "services": services}
