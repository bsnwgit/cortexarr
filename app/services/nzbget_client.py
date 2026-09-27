"""
Thin client for NZBGet's JSON-RPC API (github.com/nzbgetcom/nzbget,
docs/api) — the download-client stage of the pipeline.

NZBGet differs from the *arrs and Seerr in two ways that shape this module:

  - Auth: there's no API key. NZBGet uses its own username/password
    (ControlUsername/ControlPassword) over HTTP basic auth. Cortexarr keeps
    the pair in the service's single encrypted credential field as
    "username:password", split on the first colon here.
  - Transport: one endpoint, POST {base}/jsonrpc, {"method", "params"} with
    positional params only; errors come back in the body as "error".

64-bit sizes come as separate Hi/Lo 32-bit fields; they're combined here.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx

from app.services.arr_http import HealthResult, base
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "HealthResult",
    "test_connection", "check_health",
    "get_overview", "get_queue", "get_history",
    "pause_item", "resume_item", "move_item_top", "delete_item", "retry_item",
    "pause_all", "resume_all",
]

_APP = "NZBGet"

# Queue Status values (docs/api/LISTGROUPS.md) → display label.
_QUEUE_STATES = {
    "QUEUED": "Queued",
    "PAUSED": "Paused",
    "DOWNLOADING": "Downloading",
    "FETCHING": "Fetching NZB",
    "PP_QUEUED": "Queued for post-processing",
    "LOADING_PARS": "Loading pars",
    "VERIFYING_SOURCES": "Verifying",
    "REPAIRING": "Repairing",
    "VERIFYING_REPAIRED": "Verifying repair",
    "RENAMING": "Renaming",
    "UNPACKING": "Unpacking",
    "MOVING": "Moving",
    "POST_UNPACK_RENAMING": "Renaming",
    "POST_DOWNLOAD_RENAMING": "Renaming",
    "EXECUTING_SCRIPT": "Running script",
    "PP_FINISHED": "Finishing",
}

# History Status suffixes (docs/api/HISTORY.md) worth a readable word.
_HISTORY_DETAIL = {
    "ALL": "", "UNPACK": "unpack", "PAR": "par-check", "HEALTH": "health check",
    "GOOD": "marked good", "MARK": "marked", "SCRIPT": "post-processing script",
    "SPACE": "out of disk space", "PASSWORD": "password-protected", "DAMAGED": "damaged",
    "REPAIRABLE": "repairable", "MOVE": "moving files", "SCAN": "scanning", "BAD": "marked bad",
    "FETCH": "fetching NZB", "MANUAL": "deleted by hand", "DUPE": "duplicate", "COPY": "copy",
}


def _credentials(secret: str) -> tuple[str, str]:
    username, _, password = (secret or "").partition(":")
    return username, password


def _u64(d: dict[str, Any], stem: str) -> int:
    """A 64-bit field from its Hi/Lo halves, falling back to the MB field."""
    hi, lo = d.get(f"{stem}Hi"), d.get(f"{stem}Lo")
    if isinstance(hi, int) and isinstance(lo, int):
        return (hi << 32) + lo
    mb = d.get(f"{stem}MB")
    return int(mb) * 1024 * 1024 if isinstance(mb, (int, float)) else 0


def _iso(unix: Any) -> str | None:
    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat() if isinstance(unix, (int, float)) and unix > 0 else None


async def _call(base_url: str, secret: str, method: str, *params: Any, timeout: float = 15.0) -> Any:
    username, password = _credentials(secret)
    try:
        async with httpx.AsyncClient(timeout=timeout, auth=(username, password)) as client:
            resp = await client.post(f"{base(base_url)}/jsonrpc", json={"method": method, "params": list(params), "id": 1})
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc
    if resp.status_code in (401, 403):
        raise ConnectivityError("Username/password rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"{_APP} returned HTTP {resp.status_code}")
    if resp.status_code != 200:
        raise ServiceApiError(f"HTTP {resp.status_code} from /jsonrpc")
    try:
        data = resp.json()
    except ValueError as exc:
        raise ServiceApiError("Response wasn't NZBGet's JSON-RPC") from exc
    if not isinstance(data, dict):
        raise ServiceApiError("Response wasn't NZBGet's JSON-RPC")
    if data.get("error"):
        err = data["error"]
        raise ServiceApiError(err.get("message") if isinstance(err, dict) else str(err))
    return data.get("result")


async def test_connection(base_url: str, api_key: str, timeout: float = 10.0) -> tuple[bool, str]:
    try:
        version = await _call(base_url, api_key, "version", timeout=timeout)
    except ConnectivityError as exc:
        if "rejected" in str(exc):
            return False, "Rejected — check the username and password"
        return False, f"Could not connect: {exc}"
    except ServiceApiError:
        return False, "Got a response, but not from NZBGet's API — check the URL"
    if not isinstance(version, str):
        return False, "Got a response, but not from NZBGet's API — check the URL"
    return True, f"Connected — NZBGet {version}"


async def check_health(base_url: str, api_key: str, timeout: float = 10.0) -> HealthResult:
    """NZBGet's own configuration health report (systemhealth, v26+) where
    it exists, plus the states that stop downloads: paused, quota reached.
    Raises ConnectivityError when unreachable or the login is rejected."""
    try:
        status = await _call(base_url, api_key, "status", timeout=timeout)
    except ServiceApiError as exc:
        raise ConnectivityError(str(exc)) from exc

    issues: list[dict[str, Any]] = []
    if status.get("DownloadPaused"):
        issues.append({"type": "warning", "message": "Downloads are paused"})
    if status.get("QuotaReached"):
        issues.append({"type": "warning", "message": "Download quota reached"})
    try:
        health = await _call(base_url, api_key, "systemhealth", timeout=timeout)
    except (ConnectivityError, ServiceApiError):
        health = None  # older NZBGet: no systemhealth method
    if isinstance(health, dict):
        for alert in health.get("Alerts") or []:
            st = alert.get("Status") or {}
            severity = (st.get("Severity") or "").lower()
            if severity in ("warning", "error"):
                issues.append({"type": severity, "message": f"{alert.get('Name', '')}: {st.get('Message', '')}".strip(": ")})

    if not issues:
        return HealthResult(connectivity_ok=True, status="ok")
    severities = {i["type"] for i in issues}
    return HealthResult(
        connectivity_ok=True,
        status="error" if "error" in severities else "warning",
        issues=issues,
        detail="; ".join(i["message"] for i in issues[:5]),
    )


async def get_overview(base_url: str, api_key: str) -> dict[str, Any]:
    """The header strip: speed, what's left, disk, paused state."""
    s = await _call(base_url, api_key, "status")
    rate = _u64(s, "DownloadRate") or int(s.get("DownloadRate") or 0)
    remaining = _u64(s, "RemainingSize")
    paused = bool(s.get("DownloadPaused"))
    return {
        "download_rate": rate,
        "download_limit": int(s.get("DownloadLimit") or 0),
        "remaining_bytes": remaining,
        "eta_seconds": int(remaining / rate) if rate and not paused else None,
        "free_disk_bytes": _u64(s, "FreeDiskSpace"),
        "total_disk_bytes": _u64(s, "TotalDiskSpace"),
        "paused": paused,
        "post_jobs": int(s.get("PostJobCount") or 0),
        "quota_reached": bool(s.get("QuotaReached")),
    }


async def get_queue(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """The download queue in NZBGet's own order, with each item's ETA
    estimated from the current speed and everything ahead of it."""
    groups, status = await asyncio.gather(
        _call(base_url, api_key, "listgroups", 0),
        _call(base_url, api_key, "status"),
    )
    rate = _u64(status, "DownloadRate") or int(status.get("DownloadRate") or 0)
    global_paused = bool(status.get("DownloadPaused"))
    ahead = 0
    out = []
    for g in groups or []:
        size = _u64(g, "FileSize")
        remaining = _u64(g, "RemainingSize")
        paused_size = _u64(g, "PausedSize")
        state = g.get("Status") or ""
        item_paused = state == "PAUSED"
        eta = None
        if not item_paused and not global_paused and rate and state in ("QUEUED", "DOWNLOADING"):
            ahead += max(remaining - paused_size, 0)
            eta = int(ahead / rate)
        out.append({
            "id": g.get("NZBID"),
            "name": g.get("NZBName") or "",
            "category": g.get("Category") or "",
            "state": state,
            "state_label": _QUEUE_STATES.get(state, state.title()),
            "post_info": g.get("PostInfoText") or "",
            "post_progress_pct": round((g.get("PostStageProgress") or 0) / 10, 1),
            "size_bytes": size,
            "remaining_bytes": remaining,
            "progress_pct": round((1 - remaining / size) * 100, 1) if size else None,
            "health_pct": round((g.get("Health") or 0) / 10, 1),
            "critical_health_pct": round((g.get("CriticalHealth") or 0) / 10, 1),
            "eta_seconds": eta,
            "paused": item_paused,
            "active": (g.get("ActiveDownloads") or 0) > 0,
            # Post-processing items (par, unpack, scripts) can't be paused/moved.
            "can_control": state in ("QUEUED", "DOWNLOADING", "PAUSED", "FETCHING"),
        })
    return out


async def _reason(base_url: str, api_key: str, nzb_id: int) -> str:
    """Why a download failed or warned: the ERROR (else WARNING) lines at
    the end of its own log. Empty when the log has none."""
    try:
        entries = await _call(base_url, api_key, "loadlog", nzb_id, 0, 40)
    except (ConnectivityError, ServiceApiError):
        return ""
    entries = entries or []
    for kind in ("ERROR", "WARNING"):
        lines = [e.get("Text", "") for e in entries if e.get("Kind") == kind and e.get("Text")]
        if lines:
            return "; ".join(lines[-3:])
    return ""


async def get_history(base_url: str, api_key: str, limit: int = 200) -> list[dict[str, Any]]:
    """Finished downloads, newest first. Failed and warning items carry the
    reason from their own log (for the most recent 30 of them)."""
    items = await _call(base_url, api_key, "history", False)
    items = sorted(items or [], key=lambda h: h.get("HistoryTime") or 0, reverse=True)[:limit]
    rows = []
    for h in items:
        outcome, _, detail = (h.get("Status") or "").partition("/")
        rows.append({
            "id": h.get("NZBID"),
            "name": h.get("Name") or "",
            "title": h.get("Name") or "",  # the Activities log's title column
            "category": h.get("Category") or "",
            "outcome": outcome.lower(),
            "status": h.get("Status") or "",
            "detail": _HISTORY_DETAIL.get(detail, detail.lower()),
            "size_bytes": _u64(h, "FileSize"),
            "date": _iso(h.get("HistoryTime")),
            "event_type": outcome.title() if outcome else "",
            "source_title": None,
            "quality": "",
            "reason": "",
        })

    needs_reason = [r for r in rows if r["outcome"] in ("failure", "warning")][:30]
    sem = asyncio.Semaphore(6)

    async def fill(row: dict[str, Any]):
        async with sem:
            row["reason"] = await _reason(base_url, api_key, row["id"])

    await asyncio.gather(*(fill(r) for r in needs_reason))
    return rows


def _nzb_id(item_id: int | str) -> int:
    """Download routes take ids as strings (SABnzbd's are); NZBGet's are ints."""
    try:
        return int(item_id)
    except (TypeError, ValueError) as exc:
        raise ServiceApiError(f"Not an NZBGet item id: {item_id!r}") from exc


async def _edit(base_url: str, api_key: str, command: str, nzb_id: int | str) -> None:
    ok = await _call(base_url, api_key, "editqueue", command, "", [_nzb_id(nzb_id)])
    if ok is False:
        raise ServiceApiError(f"NZBGet refused {command}")


async def pause_item(base_url: str, api_key: str, nzb_id: int) -> None:
    await _edit(base_url, api_key, "GroupPause", nzb_id)


async def resume_item(base_url: str, api_key: str, nzb_id: int) -> None:
    await _edit(base_url, api_key, "GroupResume", nzb_id)


async def move_item_top(base_url: str, api_key: str, nzb_id: int) -> None:
    await _edit(base_url, api_key, "GroupMoveTop", nzb_id)


async def delete_item(base_url: str, api_key: str, nzb_id: int) -> None:
    """Remove from the queue into history (GroupDelete), not a final delete."""
    await _edit(base_url, api_key, "GroupDelete", nzb_id)


async def retry_item(base_url: str, api_key: str, nzb_id: int) -> None:
    """Send a finished (failed) item back to the queue to download again."""
    await _edit(base_url, api_key, "HistoryRedownload", nzb_id)


async def pause_all(base_url: str, api_key: str) -> None:
    await _call(base_url, api_key, "pausedownload")


async def resume_all(base_url: str, api_key: str) -> None:
    await _call(base_url, api_key, "resumedownload")
