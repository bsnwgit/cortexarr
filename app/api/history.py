"""
GET /api/history — reporting over time (scope #4), beyond the live views:
per-service uptime, alert frequency, and request-completion trends. Uptime
and alerts are aggregated straight from health_snapshots and alert_log;
request trends come from request_history (app/history.py's periodic scan —
see its module docstring for why that one needs its own recorded table).
"""
from __future__ import annotations

from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, Query

from app.database import get_db
from app.dependencies import CurrentUser

router = APIRouter()

_MAX_DAYS = 365


@router.get("/uptime")
async def uptime_history(
    user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), days: int = Query(30, ge=1, le=_MAX_DAYS),
):
    async with db.execute("SELECT id, name, type FROM service_instances ORDER BY name") as cur:
        services = await cur.fetchall()

    async with db.execute(
        "SELECT service_instance_id, date(checked_at) AS day, "
        "COUNT(*) AS total, SUM(connectivity_ok) AS ok "
        "FROM health_snapshots WHERE checked_at >= datetime('now', ?) "
        "GROUP BY service_instance_id, day ORDER BY day",
        (f"-{days} days",),
    ) as cur:
        rows = await cur.fetchall()

    by_service: dict[int, list[dict[str, Any]]] = {}
    for r in rows:
        by_service.setdefault(r["service_instance_id"], []).append(
            {"date": r["day"], "total": r["total"], "ok": r["ok"],
             "uptime_pct": round(100 * r["ok"] / r["total"], 1) if r["total"] else None}
        )

    out = []
    for s in services:
        days_data = by_service.get(s["id"], [])
        total = sum(d["total"] for d in days_data)
        ok = sum(d["ok"] for d in days_data)
        out.append({
            "service_id": s["id"], "service_name": s["name"], "service_type": s["type"],
            "overall_uptime_pct": round(100 * ok / total, 1) if total else None,
            "days": days_data,
        })
    return {"days": days, "services": out}


@router.get("/alerts")
async def alert_history(
    user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), days: int = Query(30, ge=1, le=_MAX_DAYS),
):
    async with db.execute(
        "SELECT date(sent_at) AS day, COUNT(*) AS n FROM alert_log "
        "WHERE kind = 'alert' AND sent_at >= datetime('now', ?) GROUP BY day ORDER BY day",
        (f"-{days} days",),
    ) as cur:
        by_day = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT rule_name, COUNT(*) AS n FROM alert_log "
        "WHERE kind = 'alert' AND sent_at >= datetime('now', ?) "
        "GROUP BY rule_name ORDER BY n DESC LIMIT 10",
        (f"-{days} days",),
    ) as cur:
        by_rule = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT service_name, COUNT(*) AS n FROM alert_log "
        "WHERE kind = 'alert' AND sent_at >= datetime('now', ?) "
        "GROUP BY service_name ORDER BY n DESC LIMIT 10",
        (f"-{days} days",),
    ) as cur:
        by_service = [dict(r) for r in await cur.fetchall()]

    return {"days": days, "by_day": by_day, "by_rule": by_rule, "by_service": by_service}


@router.get("/requests")
async def request_history(
    user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), days: int = Query(90, ge=1, le=_MAX_DAYS),
):
    async with db.execute(
        "SELECT date(available_at) AS day, COUNT(*) AS n FROM request_history "
        "WHERE available_at >= datetime('now', ?) GROUP BY day ORDER BY day",
        (f"-{days} days",),
    ) as cur:
        by_day = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT media_type, COUNT(*) AS n, AVG(duration_seconds) AS avg_duration_seconds "
        "FROM request_history WHERE available_at >= datetime('now', ?) AND media_type != '' "
        "GROUP BY media_type",
        (f"-{days} days",),
    ) as cur:
        by_media_type = [dict(r) for r in await cur.fetchall()]

    async with db.execute(
        "SELECT COUNT(*) AS n, AVG(duration_seconds) AS avg_duration_seconds "
        "FROM request_history WHERE available_at >= datetime('now', ?) AND duration_seconds IS NOT NULL",
        (f"-{days} days",),
    ) as cur:
        summary = dict(await cur.fetchone())

    return {"days": days, "by_day": by_day, "by_media_type": by_media_type, "summary": summary}
