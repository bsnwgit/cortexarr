"""
End-to-end request tracking (scope #2) — where each Seerr request is in the
pipeline, and since when:

    approval → sending → searching → downloading → importing → available

A request is tied to its Sonarr series / Radarr movie by TVDB/TMDB id — the
same ids Seerr sends with it — and, where the same title is in more than one
instance (an HD and a 4K Radarr), by the Sonarr/Radarr id Seerr recorded
(externalServiceId). Queue items then tie to that series/movie by id. There
is no title matching anywhere.

Each stage's "since" is a real timestamp from the services (request made,
approved, added to the library, download started), so a request that's been
searching for three weeks shows as that the first time Cortexarr looks.
TV requests are counted over the requested seasons ("12 of 20 episodes").

Used by the Tracking page (app/api/tracking.py) and by the alert engine,
which turns a stage that lasts too long into a stalled_<stage> condition.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import aiosqlite

from app.crypto import decrypt_str
from app.services import radarr_client, seerr_client, sonarr_client
from app.services.errors import ConnectivityError, ServiceApiError

log = logging.getLogger("cortexarr.tracking")

STAGES = ("approval", "sending", "searching", "downloading", "importing", "available")
# Stages a request can stall in — each is an alert event, stalled_<stage>.
STALLABLE = ("approval", "sending", "searching", "downloading", "importing")
STAGE_LABELS = {
    "approval": "Waiting for approval",
    "sending": "Sending to Sonarr/Radarr",
    "searching": "Searching",
    "downloading": "Downloading",
    "importing": "Importing",
    "available": "Available",
    "upcoming": "Not released yet",
    "failed": "Failed in Seerr",
    "unknown": "Can't tell",
}
# Queue states past the download itself — waiting on, or stuck in, import.
_IMPORT_STATES = {"importPending", "importing", "importBlocked", "failedPending", "failed", "imported"}


async def _services(db: aiosqlite.Connection) -> list[aiosqlite.Row]:
    async with db.execute(
        "SELECT id, name, type, base_url, api_key_enc FROM service_instances "
        "WHERE enabled = 1 AND maintenance_mode = 0 AND type IN ('sonarr', 'radarr', 'seerr') ORDER BY id",
    ) as cur:
        return await cur.fetchall()


async def _library(svc: aiosqlite.Row) -> dict[str, Any]:
    """One Sonarr/Radarr instance's library and queue."""
    key = decrypt_str(svc["api_key_enc"])
    if svc["type"] == "sonarr":
        items, queue = await asyncio.gather(sonarr_client.get_series_progress(svc["base_url"], key),
                                            sonarr_client.get_queue(svc["base_url"], key, page_size=1000))
        ext = ("tvdb_id", "tmdb_id")
    else:
        items, queue = await asyncio.gather(radarr_client.get_movies_progress(svc["base_url"], key),
                                            radarr_client.get_queue(svc["base_url"], key, page_size=1000))
        ext = ("tmdb_id",)
    by_ext: dict[tuple[str, Any], list[dict]] = {}
    for item in items:
        for field in ext:
            if item.get(field):
                by_ext.setdefault((field, item[field]), []).append(item)
    return {"service": svc, "by_ext": by_ext, "queue": queue}


def _earliest(values: list[Optional[str]]) -> Optional[str]:
    vals = [v for v in values if v]
    return min(vals) if vals else None


def _latest(values: list[Optional[str]]) -> Optional[str]:
    vals = [v for v in values if v]
    return max(vals) if vals else None


def _track(r: dict[str, Any], libs: list[dict[str, Any]], failed_types: set[str]) -> Optional[dict[str, Any]]:
    """One request's stage. None for declined requests — nothing to follow."""
    state = r.get("state")
    if state == "declined":
        return None
    kind = "sonarr" if r.get("media_type") == "tv" else "radarr"
    out = {
        "request_id": r.get("id"), "title": r.get("title") or "", "year": r.get("year"),
        "media_type": r.get("media_type"), "poster_url": r.get("poster_url") or "", "is_4k": r.get("is_4k"),
        "requested_by": r.get("requested_by"), "requested_at": r.get("requested_at"),
        "seasons": r.get("seasons") or [], "progress": None, "arr": None, "detail": "",
        "seerr_state": state,
    }
    if state == "pending":
        return {**out, "stage": "approval", "since": r.get("requested_at")}
    if state == "failed":
        return {**out, "stage": "failed", "since": r.get("updated_at")}

    # Find the series/movie by TVDB id (TV) or TMDB id — TV falls back to TMDB
    # for the odd show Seerr has no TVDB id for — preferring the instance
    # whose id for it is the one Seerr recorded.
    keys = ([("tvdb_id", r.get("tvdb_id"))] if kind == "sonarr" and r.get("tvdb_id") else []) + [("tmdb_id", r.get("tmdb_id"))]
    found = []
    for key in keys:
        found = [(lib, item) for lib in libs if lib["service"]["type"] == kind for item in lib["by_ext"].get(key, [])]
        if found:
            break
    found.sort(key=lambda li: li[1]["id"] != r.get("external_id"))
    if not found:
        if state == "available":
            return {**out, "stage": "available", "since": r.get("updated_at")}
        if kind in failed_types:
            return {**out, "stage": "unknown", "since": None,
                    "detail": f"Couldn't reach {'Sonarr' if kind == 'sonarr' else 'Radarr'} to check"}
        return {**out, "stage": "sending", "since": r.get("updated_at")}

    lib, item = found[0]
    svc = lib["service"]
    out["arr"] = {"service_id": svc["id"], "service_name": svc["name"], "type": kind, "item_id": item["id"],
                  "title": item.get("title") or ""}
    added = _latest([item.get("added"), r.get("updated_at")])

    if kind == "radarr":
        queued = [q for q in lib["queue"] if q.get("movie_id") == item["id"]]
        if queued:
            importing = any(q.get("tracked_state") in _IMPORT_STATES for q in queued)
            pct = queued[0].get("progress_pct")
            return {**out, "stage": "importing" if importing else "downloading",
                    "since": _earliest([q.get("added") for q in queued]) or added,
                    "detail": "" if importing or pct is None else f"{pct}%"}
        if item.get("has_file"):
            return {**out, "stage": "available", "since": None}
        if not item.get("is_available"):
            return {**out, "stage": "upcoming", "since": None}
        return {**out, "stage": "searching", "since": added}

    # TV: the requested seasons (all but specials if the request named none).
    seasons = out["seasons"] or [n for n in item["seasons"] if n]
    stats = [item["seasons"].get(n) or {"aired": 0, "files": 0, "total": 0} for n in seasons]
    aired, files = sum(s["aired"] for s in stats), sum(s["files"] for s in stats)
    out["progress"] = {"have": files, "of": aired}
    queued = [q for q in lib["queue"] if q.get("series_id") == item["id"] and q.get("season_number") in seasons]
    if queued:
        importing = any(q.get("tracked_state") in _IMPORT_STATES for q in queued)
        return {**out, "stage": "importing" if importing else "downloading",
                "since": _earliest([q.get("added") for q in queued]) or added,
                "detail": f"{len(queued)} episode{'' if len(queued) == 1 else 's'} in the queue"}
    if aired == 0:
        return {**out, "stage": "upcoming", "since": None}
    if files >= aired:
        return {**out, "stage": "available", "since": None}
    return {**out, "stage": "searching", "since": added, "detail": f"{aired - files} missing"}


async def track(db: aiosqlite.Connection, seerr_id: Optional[int] = None) -> dict[str, Any]:
    """Every request's stage — for one Seerr instance, or all of them.
    {"requests": [...], "errors": ["<service>: <why>", ...]}"""
    services = await _services(db)
    seerrs = [s for s in services if s["type"] == "seerr" and (seerr_id is None or s["id"] == seerr_id)]
    arrs = [s for s in services if s["type"] in ("sonarr", "radarr")]
    if not seerrs:
        return {"requests": [], "errors": []}

    fetched = await asyncio.gather(*(_library(s) for s in arrs), return_exceptions=True)
    libs, errors, failed_types = [], [], set()
    for svc, got in zip(arrs, fetched):
        if isinstance(got, Exception):
            errors.append(f"{svc['name']}: {got}")
            failed_types.add(svc["type"])
        else:
            libs.append(got)

    out = []
    for seerr in seerrs:
        try:
            reqs = await seerr_client.get_requests(seerr["base_url"], decrypt_str(seerr["api_key_enc"]))
        except (ConnectivityError, ServiceApiError) as exc:
            errors.append(f"{seerr['name']}: {exc}")
            continue
        for r in reqs:
            t = _track(r, libs, failed_types)
            if t:
                out.append({**t, "seerr": {"service_id": seerr["id"], "service_name": seerr["name"]}})
    return {"requests": out, "errors": errors}
