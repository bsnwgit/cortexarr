"""
Thin client for SABnzbd's API (sabnzbd.org/wiki/configuration/5.2/api) —
the other download client, alongside nzbget_client.py.

Returns the same normalized shapes as nzbget_client (overview / queue /
history rows), so both share one set of download views in the frontend.
SABnzbd-specific bits handled here:

  - Auth is an API key passed as the `apikey` query parameter (from
    Config → General). A bad key comes back as HTTP 200 with an "error"
    field, not a 401 — mapped to the same "key rejected" ConnectivityError.
  - Sizes and speeds are strings in MB / KB/s / GB; time left is "H:MM:SS".
  - Jobs in post-processing (verifying, repairing, extracting, ...) live in
    SABnzbd's *history*, not its queue; they're folded into the queue view
    here so "what's in flight" reads the same as NZBGet's.
  - Failed jobs carry their reason directly (`fail_message`).
"""
from __future__ import annotations

import asyncio
import time
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

_APP = "SABnzbd"
_MB = 1024 * 1024
_GB = 1024 * _MB

# Queue slot statuses where pause/resume/move/delete apply.
_DOWNLOAD_STATES = {"Downloading", "Queued", "Paused", "Propagating", "Fetching", "Grabbing"}
# History statuses that mean "still post-processing", not finished.
_PP_LABELS = {
    "Queued": "Queued for post-processing", "QuickCheck": "Quick check", "Verifying": "Verifying",
    "Repairing": "Repairing", "Fetching": "Fetching extra pars", "Extracting": "Unpacking",
    "Moving": "Moving", "Running": "Running script",
}
_QUEUE_LABELS = {"Propagating": "Waiting (propagating)", "Grabbing": "Fetching NZB"}
_WARNING_WINDOW_SECONDS = 24 * 3600


def _num(v: Any) -> float:
    try:
        return float(str(v).strip() or 0)
    except ValueError:
        return 0.0


def _seconds(timeleft: Any) -> int | None:
    """'0:16:44' / '1:02:03:04' (d:h:m:s) → seconds; None if not parseable."""
    parts = str(timeleft or "").split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    total = 0
    for n, unit in zip(reversed(nums), (1, 60, 3600, 86400)):
        total += n * unit
    return total


def _iso(unix: Any) -> str | None:
    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat() if isinstance(unix, (int, float)) and unix > 0 else None


def _raise_if_error(payload: Any) -> None:
    err = payload.get("error") if isinstance(payload, dict) else None
    if err:
        if "api key" in str(err).lower():
            raise ConnectivityError("API key rejected")
        raise ServiceApiError(str(err))


async def _api(base_url: str, api_key: str, mode: str, timeout: float = 15.0, **params: Any) -> Any:
    query = {"mode": mode, "output": "json", "apikey": api_key, **params}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{base(base_url)}/api", params=query)
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc
    if resp.status_code in (401, 403):
        raise ConnectivityError("API key rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"{_APP} returned HTTP {resp.status_code}")
    if resp.status_code != 200:
        raise ServiceApiError(f"HTTP {resp.status_code} from /api")
    try:
        data = resp.json()
    except ValueError as exc:
        # Some versions answer errors as plain text ("error: API Key Incorrect").
        text = resp.text.strip()
        if text.lower().startswith("error"):
            _raise_if_error({"error": text})
        raise ServiceApiError("Response wasn't SABnzbd's API") from exc
    _raise_if_error(data)
    return data


async def test_connection(base_url: str, api_key: str, timeout: float = 10.0) -> tuple[bool, str]:
    """`version` needs no key, so it proves the URL; a one-item queue call
    then proves the key."""
    try:
        v = await _api(base_url, api_key, "version", timeout=timeout)
        version = v.get("version") if isinstance(v, dict) else None
        if not version:
            return False, "Got a response, but not from SABnzbd's API — check the URL"
        await _api(base_url, api_key, "queue", timeout=timeout, limit=1)
        return True, f"Connected — SABnzbd {version}"
    except ConnectivityError as exc:
        if "rejected" in str(exc):
            return False, "Rejected — check the API key"
        return False, f"Could not connect: {exc}"
    except ServiceApiError:
        return False, "Got a response, but not from SABnzbd's API — check the URL"


async def check_health(base_url: str, api_key: str, timeout: float = 10.0) -> HealthResult:
    """SABnzbd's active warnings from the last day (login failures, disk
    problems, ...) plus whether downloading is paused. Raises
    ConnectivityError when unreachable or the key is rejected."""
    try:
        queue, warnings = await asyncio.gather(
            _api(base_url, api_key, "queue", timeout=timeout, limit=1),
            _api(base_url, api_key, "warnings", timeout=timeout),
        )
    except ServiceApiError as exc:
        raise ConnectivityError(str(exc)) from exc

    issues: list[dict[str, Any]] = []
    if (queue.get("queue") or {}).get("paused"):
        issues.append({"type": "warning", "message": "Downloads are paused"})
    cutoff = time.time() - _WARNING_WINDOW_SECONDS
    for w in (warnings.get("warnings") or []) if isinstance(warnings, dict) else []:
        if not isinstance(w, dict) or _num(w.get("time")) < cutoff:
            continue
        kind = "error" if str(w.get("type", "")).upper() == "ERROR" else "warning"
        issues.append({"type": kind, "message": w.get("text", "")})

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
    queue_data, history_data = await asyncio.gather(
        _api(base_url, api_key, "queue", limit=1),
        _api(base_url, api_key, "history", limit=1),
    )
    q = queue_data.get("queue") or {}
    h = history_data.get("history") or {}
    paused = bool(q.get("paused"))
    rate = int(_num(q.get("kbpersec")) * 1024)
    limit_pct = _num(q.get("speedlimit"))
    limit_abs = int(_num(q.get("speedlimit_abs")))
    return {
        "download_rate": rate,
        # A limit only counts when one is set below 100% of the line speed.
        "download_limit": limit_abs if 0 < limit_pct < 100 else 0,
        "remaining_bytes": int(_num(q.get("mbleft")) * _MB),
        "eta_seconds": None if paused or not rate else _seconds(q.get("timeleft")),
        "free_disk_bytes": int(_num(q.get("diskspace1")) * _GB),
        "total_disk_bytes": int(_num(q.get("diskspacetotal1")) * _GB),
        "paused": paused,
        "post_jobs": int(_num(h.get("ppslots"))),
        "quota_reached": False,
    }


async def get_queue(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """Downloads in SABnzbd's order, then jobs still post-processing (which
    SABnzbd keeps in its history) so the queue shows everything in flight."""
    queue_data, history_data = await asyncio.gather(
        _api(base_url, api_key, "queue", limit=500),
        _api(base_url, api_key, "history", limit=50),
    )
    q = queue_data.get("queue") or {}
    global_paused = bool(q.get("paused"))
    out = []
    for s in q.get("slots") or []:
        state = s.get("status") or ""
        size = int(_num(s.get("mb")) * _MB)
        remaining = int(_num(s.get("mbleft")) * _MB)
        item_paused = state == "Paused"
        labels = [str(x) for x in (s.get("labels") or [])]
        out.append({
            "id": s.get("nzo_id"),
            "name": s.get("filename") or "",
            "category": s.get("cat") if s.get("cat") not in (None, "*") else "",
            "state": state,
            "state_label": _QUEUE_LABELS.get(state, state),
            "post_info": ", ".join(labels),
            "post_progress_pct": 0,
            "size_bytes": size,
            "remaining_bytes": remaining,
            "progress_pct": round(_num(s.get("percentage")), 1) if size else None,
            "health_pct": None,
            "critical_health_pct": None,
            "eta_seconds": None if item_paused or global_paused else _seconds(s.get("timeleft")),
            "paused": item_paused,
            "active": state == "Downloading",
            "can_control": state in _DOWNLOAD_STATES,
        })
    for h in (history_data.get("history") or {}).get("slots") or []:
        state = h.get("status") or ""
        if state not in _PP_LABELS:
            continue
        size = int(_num(h.get("bytes")))
        out.append({
            "id": h.get("nzo_id"),
            "name": h.get("name") or "",
            "category": h.get("category") if h.get("category") not in (None, "*") else "",
            "state": state,
            "state_label": _PP_LABELS[state],
            "post_info": h.get("action_line") or "",
            "post_progress_pct": 0,
            "size_bytes": size,
            "remaining_bytes": 0,
            "progress_pct": 100.0,
            "health_pct": None,
            "critical_health_pct": None,
            "eta_seconds": None,
            "paused": False,
            "active": True,
            "can_control": False,
        })
    return out


async def get_history(base_url: str, api_key: str, limit: int = 200) -> list[dict[str, Any]]:
    """Finished jobs, newest first. Failed ones carry SABnzbd's own
    fail_message as the reason. Jobs still post-processing are left to the
    queue view."""
    data = await _api(base_url, api_key, "history", limit=limit)
    rows = []
    for h in (data.get("history") or {}).get("slots") or []:
        state = h.get("status") or ""
        if state in _PP_LABELS:
            continue
        outcome = {"Completed": "success", "Failed": "failure"}.get(state, state.lower())
        rows.append({
            "id": h.get("nzo_id"),
            "name": h.get("name") or "",
            "title": h.get("name") or "",  # the Activities log's title column
            "category": h.get("category") if h.get("category") not in (None, "*") else "",
            "outcome": outcome,
            "status": state,
            "detail": "",
            "size_bytes": int(_num(h.get("bytes"))),
            "date": _iso(h.get("completed")),
            "event_type": "Completed" if outcome == "success" else "Failed" if outcome == "failure" else state,
            "source_title": None,
            "quality": "",
            "reason": h.get("fail_message") or "",
        })
    rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return rows


def _ok(result: Any, what: str) -> None:
    if isinstance(result, dict) and result.get("status") is False:
        raise ServiceApiError(f"SABnzbd refused {what}")


async def pause_item(base_url: str, api_key: str, nzo_id: str) -> None:
    _ok(await _api(base_url, api_key, "queue", name="pause", value=nzo_id), "pause")


async def resume_item(base_url: str, api_key: str, nzo_id: str) -> None:
    _ok(await _api(base_url, api_key, "queue", name="resume", value=nzo_id), "resume")


async def move_item_top(base_url: str, api_key: str, nzo_id: str) -> None:
    _ok(await _api(base_url, api_key, "switch", value=nzo_id, value2=0), "move")


async def delete_item(base_url: str, api_key: str, nzo_id: str) -> None:
    """Remove from the queue. Files already downloaded are kept (SABnzbd's
    default without del_files)."""
    _ok(await _api(base_url, api_key, "queue", name="delete", value=nzo_id), "delete")


async def retry_item(base_url: str, api_key: str, nzo_id: str) -> None:
    _ok(await _api(base_url, api_key, "retry", value=nzo_id), "retry")


async def pause_all(base_url: str, api_key: str) -> None:
    _ok(await _api(base_url, api_key, "pause"), "pause")


async def resume_all(base_url: str, api_key: str) -> None:
    _ok(await _api(base_url, api_key, "resume"), "resume")
