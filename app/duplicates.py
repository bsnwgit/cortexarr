"""
Duplicate-file scans, per Sonarr/Radarr service: when one is due, running it in
the background, and keeping what it found.

The scan itself (SSH, the rules) is app/services/duplicate_scan.py. This is the
glue the poller, the alert engine and /api/duplicates share:

  - A service's scan is configured in its `duplicate_scan` JSON and runs on its
    own interval, apart from the health check — listing whole libraries can take
    minutes, and a slow scan must never make Sonarr look unhealthy.
  - Results live in the database (duplicate_findings, library_scans), not in
    memory, so a restart loses nothing and the alert engine and the Duplicates
    page read the same rows.
  - A failed scan keeps the last good findings and records why, rather than
    clearing real duplicates because an SSH link dropped.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import PurePosixPath
from typing import Any, Optional

import aiosqlite

from app.crypto import decrypt_str
from app.database import DB_PATH
from app.services import arr_http, duplicate_scan
from app.services.errors import ConnectivityError, ServiceApiError

log = logging.getLogger("cortexarr.duplicates")

SCAN_TYPES = tuple(duplicate_scan.KINDS)     # service types that can have a scan

_running: set[int] = set()
_tasks: set[asyncio.Task] = set()            # held so a running scan isn't garbage-collected
_attempted: dict[int, float] = {}            # service id -> monotonic time of the last attempt


def config_of(service: aiosqlite.Row | dict) -> dict[str, Any]:
    """The service's scan settings, validated — or a disabled stub when it has
    none, is not a Sonarr/Radarr, or the saved JSON no longer validates."""
    if service["type"] not in SCAN_TYPES:
        return {"enabled": False}
    try:
        return duplicate_scan.parse_config(service["duplicate_scan"])
    except (ValueError, KeyError):
        return {"enabled": False}


def scanning(service_id: int) -> bool:
    return service_id in _running


async def _store(db: aiosqlite.Connection, sid: int, result: Optional[duplicate_scan.ScanResult], error: str) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    if result is not None:
        for f in result.findings:
            await db.execute(
                "INSERT INTO duplicate_findings (service_instance_id, key, kind, title, reason, files, first_seen, last_seen) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(service_instance_id, key) DO UPDATE SET title = excluded.title, reason = excluded.reason, "
                "files = excluded.files, last_seen = excluded.last_seen",
                (sid, f.key, f.kind, f.title, f.reason, json.dumps(f.files), stamp, stamp),
            )
        keep = [f.key for f in result.findings]
        if keep:
            await db.execute(
                "DELETE FROM duplicate_findings WHERE service_instance_id = ? "
                f"AND key NOT IN ({', '.join('?' for _ in keep)})", (sid, *keep))
        else:
            await db.execute("DELETE FROM duplicate_findings WHERE service_instance_id = ?", (sid,))
        # A folder that couldn't be listed is reported as the error, but what the others found still counts.
        await db.execute(
            "INSERT INTO library_scans (service_instance_id, scanned_at, files_seen, seconds, error) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(service_instance_id) DO UPDATE SET scanned_at = excluded.scanned_at, "
            "files_seen = excluded.files_seen, seconds = excluded.seconds, error = excluded.error",
            (sid, stamp, result.files_seen, result.seconds, "; ".join(result.problems)),
        )
    else:
        await db.execute(
            "INSERT INTO library_scans (service_instance_id, scanned_at, error) VALUES (?, ?, ?) "
            "ON CONFLICT(service_instance_id) DO UPDATE SET error = excluded.error",
            (sid, stamp, error),
        )
    await db.commit()


async def forget(db: aiosqlite.Connection, sid: int) -> None:
    """Drop what a service's scan found — it was turned off, or its settings changed."""
    await db.execute("DELETE FROM duplicate_findings WHERE service_instance_id = ?", (sid,))
    await db.execute("DELETE FROM library_scans WHERE service_instance_id = ?", (sid,))
    await db.commit()
    _attempted.pop(sid, None)


async def _run(service: dict) -> None:
    sid = service["id"]
    try:
        result, error = None, ""
        try:
            result = await duplicate_scan.scan(service["type"], service["duplicate_scan"])
        except (ConnectivityError, ServiceApiError, ValueError) as exc:
            error = str(exc)
            log.info("duplicate scan of service %s failed: %s", sid, error)
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            await db.execute("PRAGMA busy_timeout=5000")
            await _store(db, sid, result, error)
    except Exception:
        log.exception("duplicate scan of service %s failed unexpectedly", sid)
    finally:
        _running.discard(sid)


def start(service: aiosqlite.Row | dict) -> bool:
    """Begin a scan in the background. False when one is already running."""
    sid = service["id"]
    if sid in _running:
        return False
    _running.add(sid)
    _attempted[sid] = time.monotonic()
    task = asyncio.create_task(_run(dict(service)))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True


async def start_if_due(db: aiosqlite.Connection, service: aiosqlite.Row) -> None:
    """Called by the poller for each Sonarr/Radarr it checks: start the scan
    when it is turned on and its interval has passed."""
    cfg = config_of(service)
    if not cfg["enabled"] or service["id"] in _running:
        return
    interval = cfg["interval_minutes"] * 60
    # A failed attempt waits a full interval too, rather than retrying every tick.
    last = _attempted.get(service["id"])
    if last is not None and time.monotonic() - last < interval:
        return
    async with db.execute(
        "SELECT CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', scanned_at) AS INTEGER) "
        "FROM library_scans WHERE service_instance_id = ?", (service["id"],),
    ) as cur:
        row = await cur.fetchone()
    if row is not None and row[0] is not None and row[0] < interval:
        _attempted.setdefault(service["id"], time.monotonic() - row[0])   # so a restart doesn't rescan early
        return
    start(service)


async def conditions(db: aiosqlite.Connection, service: aiosqlite.Row) -> Optional[list[tuple[str, str, str, str]]]:
    """What the alert engine should consider wrong with this service's files,
    as (key, event, title, detail) — or None when there is nothing to judge yet
    (a scan that has never completed must not read as "all clear"). An empty
    list, when the scan is off, clears whatever was open."""
    cfg = config_of(service)
    if not cfg["enabled"]:
        return []
    async with db.execute(
        "SELECT error FROM library_scans WHERE service_instance_id = ?", (service["id"],),
    ) as cur:
        scan_row = await cur.fetchone()
    if scan_row is None:
        return None
    async with db.execute(
        "SELECT key, title, reason, files FROM duplicate_findings WHERE service_instance_id = ? ORDER BY title",
        (service["id"],),
    ) as cur:
        rows = await cur.fetchall()
    out = [(r["key"], "duplicate", r["title"], "; ".join([r["reason"], *json.loads(r["files"] or "[]")])) for r in rows]
    if scan_row["error"]:
        out.append(("scan:error", "warning", "Duplicate scan problem", scan_row["error"]))
    return out


# ---------------------------------------------------------------------------
# Finding the series / movie a duplicate belongs to, so the page can link to it
# ---------------------------------------------------------------------------

_LIST_PATHS = {"sonarr": ("Sonarr", "/api/v3/series"), "radarr": ("Radarr", "/api/v3/movie")}
_ids_cache: dict[int, tuple[float, dict[str, int]]] = {}
_IDS_TTL = 120.0


async def folder_ids(service: aiosqlite.Row) -> dict[str, int]:
    """Folder name -> series/movie id, from the service's own `path` for each.
    Empty when the service can't be read — the link is then simply left out."""
    sid = service["id"]
    cached = _ids_cache.get(sid)
    if cached and time.monotonic() - cached[0] < _IDS_TTL:
        return cached[1]
    app, path = _LIST_PATHS[service["type"]]
    try:
        data = await arr_http.get(app, service["base_url"], decrypt_str(service["api_key_enc"]), path)
    except (ConnectivityError, ServiceApiError):
        return {}
    ids = {PurePosixPath(r["path"]).name: r["id"] for r in (data if isinstance(data, list) else [])
           if r.get("path") and r.get("id") is not None}
    _ids_cache[sid] = (time.monotonic(), ids)
    return ids


def folder_of(files: list[str], roots: list[str]) -> str:
    """The movie/series folder a finding's files sit in: the first part below a configured folder."""
    for root in roots:
        if files and files[0].startswith(root + "/"):
            return PurePosixPath(files[0]).relative_to(root).parts[0]
    return ""
