"""
Thin client for Sonarr's v3 API.

  - GET /api/v3/system/status — a cheap call to prove the URL/API key work
    at all. Used for the "test connection" endpoint (scope #19) and to
    distinguish connectivity/auth failure from an app-reported problem
    (scope #8).
  - GET /api/v3/health — Sonarr's own computed list of health issues
    (indexer errors, import failures, download-client problems, etc.).
    This is the "app-level health" source (scope #1) — Cortexarr surfaces
    it, it doesn't reimplement it.
  - get_queue / get_wanted_missing / get_calendar / get_series / get_history
    — the detail views behind `GET /api/services/{id}/detail/{view}`
    (app/api/services.py). These are read-through proxies, not cached —
    Sonarr is the source of truth for its own queue/library state, so
    Cortexarr doesn't keep a second, staleable copy of it.

Both calls use the same X-Api-Key header auth Sonarr expects everywhere.

This module is the pattern for future per-service clients (Radarr's v3 API
is nearly identical): same function names, same (base_url, api_key) shape,
same ConnectivityError contract, dispatched by `service.type` in
app/api/services.py's `_DETAIL_CLIENTS`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "HealthResult",
    "test_connection", "check_health",
    "get_queue", "get_wanted_missing", "get_calendar", "get_series", "get_history",
]


@dataclass
class HealthResult:
    connectivity_ok: bool
    status: str  # 'ok' | 'warning' | 'error' | 'unreachable'
    issues: list[dict[str, Any]] = field(default_factory=list)
    detail: str = ""


def _base(base_url: str) -> str:
    return base_url.rstrip("/")


async def test_connection(base_url: str, api_key: str, timeout: float = 10.0) -> tuple[bool, str]:
    """Returns (ok, message). Used by the "test connection" UI action."""
    url = f"{_base(base_url)}/api/v3/system/status"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"X-Api-Key": api_key})
        if resp.status_code == 401:
            return False, "Rejected — check the API key"
        if resp.status_code == 404:
            return False, "Got a response, but not from Sonarr's API — check the URL"
        resp.raise_for_status()
        data = resp.json()
        version = data.get("version", "unknown")
        return True, f"Connected — Sonarr {version}"
    except httpx.TimeoutException:
        return False, f"Timed out after {timeout:.0f}s"
    except httpx.ConnectError as exc:
        return False, f"Could not connect: {exc}"
    except httpx.HTTPStatusError as exc:
        return False, f"HTTP {exc.response.status_code}"
    except Exception as exc:  # noqa: BLE001 - surfaced to the admin as a message, not raised
        return False, f"Unexpected error: {exc}"


async def check_health(base_url: str, api_key: str, timeout: float = 10.0) -> HealthResult:
    """Fetch Sonarr's own health-issue list. Raises ConnectivityError if
    Sonarr itself can't be reached or the key is bad — the caller (the
    poller) records that as connectivity_ok=False, not status='error'."""
    url = f"{_base(base_url)}/api/v3/health"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"X-Api-Key": api_key})
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc

    if resp.status_code == 401:
        raise ConnectivityError("API key rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"Sonarr returned HTTP {resp.status_code}")
    resp.raise_for_status()

    issues = resp.json()
    if not isinstance(issues, list):
        issues = []

    if not issues:
        return HealthResult(connectivity_ok=True, status="ok")

    severities = {issue.get("type", "warning") for issue in issues}
    status = "error" if "error" in severities else "warning"
    summary = "; ".join(issue.get("message", "") for issue in issues[:5])
    return HealthResult(connectivity_ok=True, status=status, issues=issues, detail=summary)


async def _get(base_url: str, api_key: str, path: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> Any:
    url = f"{_base(base_url)}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"X-Api-Key": api_key}, params=params)
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc
    if resp.status_code == 401:
        raise ConnectivityError("API key rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"Sonarr returned HTTP {resp.status_code}")
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise ServiceApiError(f"HTTP {exc.response.status_code} from {path}") from exc
    return resp.json()


def _episode_label(episode: dict[str, Any]) -> str:
    season = episode.get("seasonNumber")
    ep = episode.get("episodeNumber")
    if season is None or ep is None:
        return episode.get("title", "")
    return f"S{season:02d}E{ep:02d} — {episode.get('title', '')}"


async def get_queue(base_url: str, api_key: str, page_size: int = 50) -> list[dict[str, Any]]:
    """Currently downloading/importing — the "what's Sonarr doing right now" view."""
    data = await _get(
        base_url, api_key, "/api/v3/queue",
        params={"pageSize": page_size, "includeSeries": "true", "includeEpisode": "true"},
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    out = []
    for r in records:
        size = r.get("size") or 0
        sizeleft = r.get("sizeleft") or 0
        progress = round((1 - sizeleft / size) * 100, 1) if size else None

        # statusMessages is [{title: <release/file name>, messages: [<actual
        # text, e.g. "Not enough disk space to import">]}] — the title alone
        # (what this used to surface) is just the filename repeated; the
        # reason it's stuck is in the nested messages. errorMessage is a
        # separate top-level field for download-client-level failures.
        messages: list[str] = []
        for sm in r.get("statusMessages", []) or []:
            messages.extend(sm.get("messages", []) or [])
        if r.get("errorMessage"):
            messages.append(r["errorMessage"])

        out.append({
            "id": r.get("id"),
            "series": (r.get("series") or {}).get("title", ""),
            "episode": _episode_label(r.get("episode") or {}),
            "quality": ((r.get("quality") or {}).get("quality") or {}).get("name", ""),
            "status": r.get("status"),
            "tracked_status": r.get("trackedDownloadStatus"),
            # The pipeline stage (downloading/importPending/failed/...) — the
            # signal that actually says "done downloading, stuck on import,"
            # which progress_pct alone can't show (100% just means the
            # download itself finished).
            "tracked_state": r.get("trackedDownloadState"),
            "progress_pct": progress,
            "timeleft": r.get("timeleft"),
            "download_client": r.get("downloadClient"),
            "messages": messages,
        })
    return out


async def get_wanted_missing(base_url: str, api_key: str, page_size: int = 50) -> list[dict[str, Any]]:
    """Monitored episodes Sonarr doesn't have a file for yet."""
    data = await _get(
        base_url, api_key, "/api/v3/wanted/missing",
        params={
            "pageSize": page_size, "includeSeries": "true",
            "sortKey": "airDateUtc", "sortDirection": "descending",
        },
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    return [
        {
            "id": r.get("id"),
            "series": (r.get("series") or {}).get("title", ""),
            "episode": _episode_label(r),
            "air_date": r.get("airDate"),
            "monitored": r.get("monitored", False),
        }
        for r in records
    ]


async def get_calendar(base_url: str, api_key: str, days_back: int = 1, days_forward: int = 14) -> list[dict[str, Any]]:
    """Upcoming (and recently aired) episodes."""
    from datetime import date, timedelta
    start = (date.today() - timedelta(days=days_back)).isoformat()
    end = (date.today() + timedelta(days=days_forward)).isoformat()
    data = await _get(
        base_url, api_key, "/api/v3/calendar",
        params={"start": start, "end": end, "includeSeries": "true"},
    )
    records = data if isinstance(data, list) else []
    return [
        {
            "id": r.get("id"),
            "series": (r.get("series") or {}).get("title", ""),
            "episode": _episode_label(r),
            "air_date": r.get("airDateUtc") or r.get("airDate"),
            "has_file": r.get("hasFile", False),
            "monitored": r.get("monitored", False),
        }
        for r in records
    ]


async def get_series(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """The monitored library — one row per series with file/episode counts."""
    data = await _get(base_url, api_key, "/api/v3/series")
    records = data if isinstance(data, list) else []
    out = []
    for r in records:
        stats = r.get("statistics") or {}
        out.append({
            "id": r.get("id"),
            "title": r.get("title", ""),
            "status": r.get("status"),
            "monitored": r.get("monitored", False),
            "episode_file_count": stats.get("episodeFileCount", 0),
            "episode_count": stats.get("episodeCount", 0),
            "size_on_disk": stats.get("sizeOnDisk", 0),
            "network": r.get("network", ""),
        })
    out.sort(key=lambda s: s["title"].lower())
    return out


async def get_history(base_url: str, api_key: str, page_size: int = 50) -> list[dict[str, Any]]:
    """Recent grab/import/failure events, newest first."""
    data = await _get(
        base_url, api_key, "/api/v3/history",
        params={
            "pageSize": page_size, "includeSeries": "true", "includeEpisode": "true",
            "sortKey": "date", "sortDirection": "descending",
        },
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    return [
        {
            "id": r.get("id"),
            "event_type": r.get("eventType"),
            "series": (r.get("series") or {}).get("title", ""),
            "episode": _episode_label(r.get("episode") or {}),
            "source_title": r.get("sourceTitle"),
            "quality": ((r.get("quality") or {}).get("quality") or {}).get("name", ""),
            "date": r.get("date"),
        }
        for r in records
    ]
