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
  - set_series_monitored — the one write path so far, behind
    `PATCH /api/services/{id}/series/{series_id}/monitored`. Everything
    else in this module only reads Sonarr.

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
    "get_series_detail", "get_season_episodes", "get_season_history",
    "get_series_calendar", "get_series_history",
    "set_series_monitored", "set_episode_monitored", "set_season_monitored",
    "search_episode", "search_season",
    "delete_episode_file", "delete_series",
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


async def _put(base_url: str, api_key: str, path: str, body: dict[str, Any], timeout: float = 15.0) -> Any:
    url = f"{_base(base_url)}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.put(url, headers={"X-Api-Key": api_key}, json=body)
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


async def _post(base_url: str, api_key: str, path: str, body: dict[str, Any], timeout: float = 15.0) -> Any:
    url = f"{_base(base_url)}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers={"X-Api-Key": api_key}, json=body)
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
    return resp.json() if resp.content else None


async def _delete(base_url: str, api_key: str, path: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> None:
    url = f"{_base(base_url)}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.delete(url, headers={"X-Api-Key": api_key}, params=params)
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


def _cover_url(images: list[dict[str, Any]] | None, cover_type: str) -> str:
    """Prefer remoteUrl (a public CDN — thetvdb/fanart.tv — the frontend can
    load directly) over Sonarr's own `url`, which is a path on Sonarr itself
    and would need a proxied, authenticated request to load."""
    for img in images or []:
        if img.get("coverType") == cover_type and img.get("remoteUrl"):
            return img["remoteUrl"]
    return ""


def _year_range(r: dict[str, Any]) -> str:
    """"2021 - 2023", "2021 -" (still running), or "" if no air date at all."""
    first = r.get("firstAired") or ""
    start = first[:4] if first else ""
    if not start:
        return ""
    if r.get("status") == "ended":
        last = r.get("previousAiring") or ""
        end = last[:4] if last else start
        return f"{start} - {end}"
    return f"{start} -"


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
            "series_id": r.get("seriesId"),
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
            "series_id": r.get("seriesId"),
            "season_number": r.get("seasonNumber"),
            "episode_number": r.get("episodeNumber"),
            "episode": _episode_label(r),
            "air_date": r.get("airDate"),
            "monitored": r.get("monitored", False),
        }
        for r in records
    ]


def _calendar_worth_showing(r: dict[str, Any]) -> bool:
    """Hide only the "already aired and already downloaded" case — that
    entry has nothing left to tell you. Everything else stays: upcoming
    episodes (downloaded or not — a calendar's job is showing what's
    coming), and past episodes still missing their file (a real gap)."""
    if r.get("hasFile", False):
        from datetime import datetime, timezone
        air_date_raw = r.get("airDateUtc") or r.get("airDate")
        if air_date_raw:
            try:
                air_dt = datetime.fromisoformat(air_date_raw.replace("Z", "+00:00"))
                if air_dt.tzinfo is None:
                    air_dt = air_dt.replace(tzinfo=timezone.utc)
                if air_dt < datetime.now(timezone.utc):
                    return False
            except ValueError:
                pass
    return True


async def get_calendar(base_url: str, api_key: str, start: str, end: str) -> list[dict[str, Any]]:
    """Calendar events for an explicit date range (ISO date strings) — the
    Calendar tab's month grid, one page per month rather than a fixed
    relative window. Missing-only: see _calendar_worth_showing."""
    data = await _get(
        base_url, api_key, "/api/v3/calendar",
        params={"start": start, "end": end, "includeSeries": "true"},
    )
    records = data if isinstance(data, list) else []
    return [
        {
            "id": r.get("id"),
            "series": (r.get("series") or {}).get("title", ""),
            "series_id": r.get("seriesId"),
            "season_number": r.get("seasonNumber"),
            "episode": _episode_label(r),
            "air_date": r.get("airDateUtc") or r.get("airDate"),
            "has_file": r.get("hasFile", False),
            "monitored": r.get("monitored", False),
        }
        for r in records
        if _calendar_worth_showing(r)
    ]


async def get_series_calendar(base_url: str, api_key: str, series_id: int, start: str, end: str) -> list[dict[str, Any]]:
    """One series' calendar events for an explicit date range — the series
    header's Calendar button's month grid. Same exclusion rule as
    get_calendar, filtered down to one series."""
    data = await _get(
        base_url, api_key, "/api/v3/calendar",
        params={"start": start, "end": end, "includeSeries": "true"},
    )
    records = data if isinstance(data, list) else []
    return [
        {
            "id": r.get("id"),
            "series_id": r.get("seriesId"),
            "season_number": r.get("seasonNumber"),
            "episode": _episode_label(r),
            "air_date": r.get("airDateUtc") or r.get("airDate"),
            "has_file": r.get("hasFile", False),
            "monitored": r.get("monitored", False),
        }
        for r in records
        if r.get("seriesId") == series_id and _calendar_worth_showing(r)
    ]


async def get_series(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """The monitored library — one row per series, with enough for the
    horizontal poster-list view (scope: series library redesign)."""
    data = await _get(base_url, api_key, "/api/v3/series")
    records = data if isinstance(data, list) else []
    out = []
    for r in records:
        stats = r.get("statistics") or {}
        seasons = [s for s in (r.get("seasons") or []) if s.get("seasonNumber", 0) > 0]
        out.append({
            "id": r.get("id"),
            "title": r.get("title", ""),
            "status": r.get("status"),
            "monitored": r.get("monitored", False),
            "episode_file_count": stats.get("episodeFileCount", 0),
            "episode_count": stats.get("episodeCount", 0),
            "size_on_disk": stats.get("sizeOnDisk", 0),
            "network": r.get("network", ""),
            "poster_url": _cover_url(r.get("images"), "poster"),
            "fanart_url": _cover_url(r.get("images"), "fanart"),
            "year_range": _year_range(r),
            "season_count": len(seasons),
        })
    out.sort(key=lambda s: s["title"].lower())
    return out


async def get_series_detail(base_url: str, api_key: str, series_id: int) -> dict[str, Any]:
    """One series with its season breakdown — the series overview page.

    The header's totals (episodes, size) are summed from the per-season
    statistics below rather than trusted from the series resource's own
    top-level `statistics` — that field has been observed stale on Sonarr's
    side right after a season is added (e.g. a season's episodes show up
    correctly per-season but the series-level aggregate still reflects the
    old total). Summing what we already fetch per season is always
    self-consistent with what the page actually displays underneath it."""
    r = await _get(base_url, api_key, f"/api/v3/series/{series_id}")
    seasons = []
    for s in r.get("seasons", []) or []:
        sstats = s.get("statistics") or {}
        seasons.append({
            "season_number": s.get("seasonNumber"),
            "monitored": s.get("monitored", False),
            "episode_file_count": sstats.get("episodeFileCount", 0),
            "episode_count": sstats.get("episodeCount", 0),
            "size_on_disk": sstats.get("sizeOnDisk", 0),
            "percent_complete": sstats.get("percentOfEpisodes", 0),
        })
    # Real seasons newest-first (highest season number first); Specials
    # (season 0) always last regardless of that ordering.
    seasons.sort(key=lambda s: (1, 0) if not s["season_number"] else (0, -s["season_number"]))
    real_seasons = [s for s in seasons if s["season_number"] and s["season_number"] > 0]
    return {
        "id": r.get("id"),
        "title": r.get("title", ""),
        "status": r.get("status"),
        "monitored": r.get("monitored", False),
        "network": r.get("network", ""),
        "overview": r.get("overview", ""),
        "poster_url": _cover_url(r.get("images"), "poster"),
        "fanart_url": _cover_url(r.get("images"), "fanart"),
        "year_range": _year_range(r),
        "season_count": len(real_seasons),
        "episode_file_count": sum(s["episode_file_count"] for s in seasons),
        "episode_count": sum(s["episode_count"] for s in seasons),
        "size_on_disk": sum(s["size_on_disk"] for s in seasons),
        "seasons": seasons,
    }


async def get_season_episodes(base_url: str, api_key: str, series_id: int, season_number: int) -> list[dict[str, Any]]:
    """Episode rows for one season, expanded on demand rather than loaded
    with the series (a season row's episode list can be sizable, and most
    seasons on the page are collapsed)."""
    data = await _get(
        base_url, api_key, "/api/v3/episode",
        params={"seriesId": series_id, "seasonNumber": season_number},
    )
    records = data if isinstance(data, list) else []
    out = []
    for r in records:
        out.append({
            "id": r.get("id"),
            "episode_number": r.get("episodeNumber"),
            "title": r.get("title", ""),
            "air_date": r.get("airDateUtc") or r.get("airDate"),
            "monitored": r.get("monitored", False),
            "has_file": r.get("hasFile", False),
            "episode_file_id": r.get("episodeFileId") or None,
        })
    out.sort(key=lambda e: e["episode_number"] if e["episode_number"] is not None else -1, reverse=True)
    return out


async def get_season_history(base_url: str, api_key: str, series_id: int, season_number: int, page_size: int = 200) -> list[dict[str, Any]]:
    """History events for one season's episodes — the season History modal.
    Sonarr's history endpoint filters by series, not by season, so the
    season filtering happens here."""
    data = await _get(
        base_url, api_key, "/api/v3/history",
        params={
            "seriesId": series_id, "pageSize": page_size,
            "includeEpisode": "true", "sortKey": "date", "sortDirection": "descending",
        },
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    out = []
    for r in records:
        episode = r.get("episode") or {}
        if episode.get("seasonNumber") != season_number:
            continue
        out.append({
            "id": r.get("id"),
            "event_type": r.get("eventType"),
            "episode": _episode_label(episode),
            "source_title": r.get("sourceTitle"),
            "quality": ((r.get("quality") or {}).get("quality") or {}).get("name", ""),
            "date": r.get("date"),
        })
    return out


async def search_episode(base_url: str, api_key: str, episode_id: int) -> None:
    """Trigger Sonarr to search for one episode's release."""
    await _post(base_url, api_key, "/api/v3/command", {"name": "EpisodeSearch", "episodeIds": [episode_id]})


async def search_season(base_url: str, api_key: str, series_id: int, season_number: int) -> None:
    """Trigger Sonarr to search for a whole season's releases."""
    await _post(
        base_url, api_key, "/api/v3/command",
        {"name": "SeasonSearch", "seriesId": series_id, "seasonNumber": season_number},
    )


async def delete_episode_file(base_url: str, api_key: str, episode_file_id: int) -> None:
    """Delete one episode's file from disk via Sonarr (not just unmonitor
    it) — the trash-can action on a present episode."""
    await _delete(base_url, api_key, f"/api/v3/episodefile/{episode_file_id}")


async def delete_series(base_url: str, api_key: str, series_id: int, delete_files: bool = False) -> None:
    """Remove a series from Sonarr. delete_files defaults to False — this
    only stops Sonarr from managing it, it does not touch anything on disk
    unless the caller explicitly opts in."""
    await _delete(
        base_url, api_key, f"/api/v3/series/{series_id}",
        params={"deleteFiles": str(delete_files).lower(), "addImportListExclusion": "false"},
    )


async def set_series_monitored(base_url: str, api_key: str, series_id: int, monitored: bool) -> None:
    """Flip a series's monitored flag. Sonarr's series endpoint is a full
    resource PUT, not a partial patch — fetch the series, flip the one
    field, and send the whole thing back."""
    series = await _get(base_url, api_key, f"/api/v3/series/{series_id}")
    series["monitored"] = monitored
    await _put(base_url, api_key, f"/api/v3/series/{series_id}", series)


async def set_season_monitored(base_url: str, api_key: str, series_id: int, season_number: int, monitored: bool) -> None:
    """Flip one season's monitored flag. Same full-resource-PUT shape as
    set_series_monitored — Sonarr has no dedicated season-monitor endpoint
    the way it does for episodes."""
    series = await _get(base_url, api_key, f"/api/v3/series/{series_id}")
    for s in series.get("seasons", []) or []:
        if s.get("seasonNumber") == season_number:
            s["monitored"] = monitored
            break
    else:
        raise ServiceApiError(f"Season {season_number} not found on series {series_id}")
    await _put(base_url, api_key, f"/api/v3/series/{series_id}", series)


async def set_episode_monitored(base_url: str, api_key: str, episode_id: int, monitored: bool) -> None:
    """Flip one episode's monitored flag — the Missing tab's toggle. Unlike
    series, Sonarr has a dedicated bulk endpoint for this
    (PUT /api/v3/episode/monitor, {episodeIds, monitored}) rather than a
    full-resource replace."""
    await _put(
        base_url, api_key, "/api/v3/episode/monitor",
        {"episodeIds": [episode_id], "monitored": monitored},
    )


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


async def get_series_history(base_url: str, api_key: str, series_id: int, page_size: int = 200) -> list[dict[str, Any]]:
    """All history for one series (every season) — the series header's
    History button. Unlike get_season_history, Sonarr's history endpoint
    filters by seriesId natively, so no client-side season filtering is
    needed here."""
    data = await _get(
        base_url, api_key, "/api/v3/history",
        params={
            "seriesId": series_id, "pageSize": page_size,
            "includeEpisode": "true", "sortKey": "date", "sortDirection": "descending",
        },
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    return [
        {
            "id": r.get("id"),
            "event_type": r.get("eventType"),
            "episode": _episode_label(r.get("episode") or {}),
            "source_title": r.get("sourceTitle"),
            "quality": ((r.get("quality") or {}).get("quality") or {}).get("name", ""),
            "date": r.get("date"),
        }
        for r in records
    ]
