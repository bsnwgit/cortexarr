"""
Thin client for Seerr's v1 API (the Overseerr/Jellyseerr successor,
github.com/seerr-team/seerr) — the request side of the pipeline.

Seerr isn't an *arr: there's no library, queue, or calendar, just requests
and issues. It shares arr_http.py's transport and error contract (same
X-Api-Key header), but its paths are /api/v1 and two things work
differently:

  - Health: Seerr has no health-issue endpoint, and /api/v1/status is
    public (it doesn't check the key). So a check reads /status for version
    and "restart required" / "update available", then makes one keyed call
    (/request/count) to prove the key actually works.
  - Titles: request and issue objects carry only TMDB/TVDB ids, no title or
    art (Seerr's own UI looks each one up). Those lookups go through Seerr's
    /movie/{id} and /tv/{id} and are cached in-process — metadata rarely
    changes, unlike request state, which is always read live.

Field names and status codes follow seerr-api.yml and
server/constants/{media,issue}.ts in the Seerr repo.
"""
from __future__ import annotations

import asyncio
import time
from functools import partial
from typing import Any

import httpx

from app.services import arr_http
from app.services.arr_http import HealthResult
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "HealthResult",
    "test_connection", "check_health",
    "get_requests", "get_issues", "get_history",
    "approve_request", "decline_request", "retry_request", "delete_request",
]

_APP = "Seerr"
_API = "/api/v1"

_get = partial(arr_http.get, _APP)
_post = partial(arr_http.post, _APP)
_delete = partial(arr_http.delete, _APP)

# server/constants/media.ts
_REQ_PENDING, _REQ_APPROVED, _REQ_DECLINED, _REQ_FAILED, _REQ_COMPLETED = 1, 2, 3, 4, 5
_MEDIA_PROCESSING, _MEDIA_PARTIAL, _MEDIA_AVAILABLE = 3, 4, 5

# server/constants/issue.ts
_ISSUE_TYPES = {1: "Video", 2: "Audio", 3: "Subtitles", 4: "Other"}

_TMDB_IMG = "https://image.tmdb.org/t/p"
_META_TTL = 6 * 3600
_meta_cache: dict[tuple[str, str, int], tuple[float, dict[str, Any]]] = {}


async def test_connection(base_url: str, api_key: str, timeout: float = 10.0) -> tuple[bool, str]:
    """Returns (ok, message). /status proves it's Seerr; /request/count
    proves the key, since /status doesn't check it."""
    try:
        status = await _get(base_url, api_key, f"{_API}/status", timeout=timeout)
        if not isinstance(status, dict) or "version" not in status:
            return False, "Got a response, but not from Seerr's API — check the URL"
        await _get(base_url, api_key, f"{_API}/request/count", timeout=timeout)
        return True, f"Connected — Seerr {status['version']}"
    except ConnectivityError as exc:
        if "rejected" in str(exc):
            return False, "Rejected — check the API key"
        return False, f"Could not connect: {exc}"
    except ServiceApiError as exc:
        if "HTTP 403" in str(exc):
            return False, "Rejected — check the API key"
        return False, "Got a response, but not from Seerr's API — check the URL"
    except (ValueError, httpx.HTTPError):
        # Non-JSON (e.g. another app's web UI answering the path).
        return False, "Got a response, but not from Seerr's API — check the URL"


async def looks_like_seerr(base_url: str, timeout: float = 10.0) -> bool:
    """Whether this URL answers as Seerr — its public /status returns JSON
    with version and commitTag. Used to refuse saving a Seerr URL under
    another type; any failure means "can't tell", not "no"."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{arr_http.base(base_url)}{_API}/status")
        data = resp.json() if resp.status_code == 200 else None
    except Exception:  # noqa: BLE001 - "can't tell" is a valid answer here
        return False
    return isinstance(data, dict) and "version" in data and "commitTag" in data


async def check_health(base_url: str, api_key: str, timeout: float = 10.0) -> HealthResult:
    """Seerr's equivalent of an *arr health check. Raises ConnectivityError
    when unreachable or the key is rejected (the poller records that as
    connectivity_ok=False)."""
    try:
        status = await _get(base_url, api_key, f"{_API}/status", timeout=timeout)
        await _get(base_url, api_key, f"{_API}/request/count", timeout=timeout)
    except ServiceApiError as exc:
        # Seerr answers a bad key with 403, not the *arrs' 401.
        raise ConnectivityError("API key rejected" if "HTTP 403" in str(exc) else str(exc)) from exc
    except ValueError as exc:
        raise ConnectivityError("Response wasn't Seerr's API") from exc

    issues: list[dict[str, Any]] = []
    if status.get("restartRequired"):
        issues.append({"type": "warning", "message": "Seerr needs a restart to apply a settings change"})
    if status.get("updateAvailable"):
        issues.append({"type": "warning", "message": "A Seerr update is available"})
    if not issues:
        return HealthResult(connectivity_ok=True, status="ok")
    return HealthResult(
        connectivity_ok=True, status="warning", issues=issues,
        detail="; ".join(i["message"] for i in issues),
    )


def _image(path: str | None, size: str) -> str:
    return f"{_TMDB_IMG}/{size}{path}" if path else ""


async def _fetch_meta(base_url: str, api_key: str, media_type: str, tmdb_id: int) -> dict[str, Any]:
    key = (base_url, media_type, tmdb_id)
    hit = _meta_cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    path = f"{_API}/movie/{tmdb_id}" if media_type == "movie" else f"{_API}/tv/{tmdb_id}"
    try:
        d = await _get(base_url, api_key, path)
    except (ConnectivityError, ServiceApiError, ValueError):
        # A lookup failing shouldn't blank the whole list — show the id,
        # and don't cache, so it's retried next time.
        return {"title": f"TMDB {tmdb_id}", "year": None, "poster_url": "", "backdrop_url": ""}
    date = d.get("releaseDate") or d.get("firstAirDate") or ""
    meta = {
        "title": d.get("title") or d.get("name") or f"TMDB {tmdb_id}",
        "year": int(date[:4]) if date[:4].isdigit() else None,
        "poster_url": _image(d.get("posterPath"), "w342"),
        "backdrop_url": _image(d.get("backdropPath"), "w780"),
    }
    _meta_cache[key] = (time.monotonic() + _META_TTL, meta)
    return meta


async def _meta_for(base_url: str, api_key: str, media: list[dict[str, Any]]) -> dict[tuple[str, int], dict[str, Any]]:
    """Titles/art for a batch of media objects, one lookup per distinct
    title, at most 8 in flight at once."""
    wanted = {(m.get("mediaType"), m.get("tmdbId")) for m in media if m.get("tmdbId")}
    sem = asyncio.Semaphore(8)

    async def one(media_type: str, tmdb_id: int):
        async with sem:
            return (media_type, tmdb_id), await _fetch_meta(base_url, api_key, media_type, tmdb_id)

    pairs = await asyncio.gather(*(one(t, i) for t, i in wanted))
    return dict(pairs)


def _user_name(u: dict[str, Any] | None) -> str:
    u = u or {}
    return u.get("displayName") or u.get("username") or u.get("plexUsername") or u.get("jellyfinUsername") or ""


def _request_state(r: dict[str, Any]) -> str:
    """One status per request, combining the request's own status with its
    media's (an approved request reads Processing/Available once the
    *arr picks it up)."""
    status = r.get("status")
    if status == _REQ_PENDING:
        return "pending"
    if status == _REQ_DECLINED:
        return "declined"
    if status == _REQ_FAILED:
        return "failed"
    media = r.get("media") or {}
    media_status = media.get("status4k") if r.get("is4k") else media.get("status")
    if media_status == _MEDIA_AVAILABLE:
        return "available"
    if media_status == _MEDIA_PARTIAL:
        return "partial"
    if media_status == _MEDIA_PROCESSING:
        return "processing"
    return "approved"


async def get_requests(base_url: str, api_key: str, take: int = 100) -> list[dict[str, Any]]:
    """The most recent requests, newest first, with title/poster filled in."""
    data = await _get(
        base_url, api_key, f"{_API}/request",
        params={"take": take, "skip": 0, "filter": "all", "sort": "added", "sortDirection": "desc"},
    )
    results = data.get("results", []) if isinstance(data, dict) else []
    meta = await _meta_for(base_url, api_key, [r.get("media") or {} for r in results])
    out = []
    for r in results:
        media = r.get("media") or {}
        media_type = r.get("type") or media.get("mediaType") or ""
        m = meta.get((media.get("mediaType"), media.get("tmdbId")), {})
        out.append({
            "id": r.get("id"),
            "media_type": media_type,
            "tmdb_id": media.get("tmdbId"),
            "tvdb_id": media.get("tvdbId"),
            # The series/movie id in the Sonarr/Radarr Seerr sent it to — how
            # request tracking tells an HD instance from a 4K one.
            "external_id": media.get("externalServiceId4k") if r.get("is4k") else media.get("externalServiceId"),
            "title": m.get("title", ""),
            "year": m.get("year"),
            "poster_url": m.get("poster_url", ""),
            "backdrop_url": m.get("backdrop_url", ""),
            "seasons": sorted(s.get("seasonNumber") for s in (r.get("seasons") or []) if s.get("seasonNumber") is not None),
            "is_4k": bool(r.get("is4k")),
            "requested_by": _user_name(r.get("requestedBy")),
            "requested_at": r.get("createdAt"),
            "updated_at": r.get("updatedAt"),
            "state": _request_state(r),
        })
    return out


# Seerr's log API is rate limited (50/min) and re-reads its whole log file
# per call, so one read is shared for a minute per instance.
_LOG_TTL = 60
_log_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
# Log labels Seerr's Radarr/Sonarr wrappers use for the underlying error.
_CAUSE_LABELS = {"Radarr", "Radarr API", "Sonarr", "Sonarr API"}
_CAUSE_WINDOW_SECONDS = 120


async def _recent_problem_logs(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """Recent warn/error log entries, newest first. Empty if the log can't
    be read (no permission, rotated, Seerr too old) — a missing reason is
    shown as such, never as an error."""
    hit = _log_cache.get(base_url)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        data = await _get(base_url, api_key, f"{_API}/settings/logs", params={"take": 1000, "filter": "warn"})
    except (ConnectivityError, ServiceApiError, ValueError):
        return []
    entries = data.get("results", []) if isinstance(data, dict) else data if isinstance(data, list) else []
    _log_cache[base_url] = (time.monotonic() + _LOG_TTL, entries)
    return entries


def _parse_ts(raw: Any) -> float | None:
    from datetime import datetime
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _cause_text(entry: dict[str, Any]) -> str:
    """The most specific reason in a Radarr/Sonarr error entry — the *arr's
    own validation messages when present ("This movie has already been
    added"), else the HTTP error, else the log message."""
    data = entry.get("data") or {}
    response = data.get("response")
    messages: list[str] = []
    if isinstance(response, list):
        messages = [r.get("errorMessage") for r in response if isinstance(r, dict) and r.get("errorMessage")]
    elif isinstance(response, dict):
        messages = [response.get("message") or response.get("errorMessage") or ""]
    messages = [m for m in messages if m]
    if messages:
        return "; ".join(messages)
    return data.get("errorMessage") or entry.get("message") or ""


def _failure_reason(request_id: int, logs: list[dict[str, Any]]) -> str | None:
    """Why a request failed, from Seerr's log: its "marking status as
    FAILED" line (matched by requestId), plus the Radarr/Sonarr error
    logged just before it. None when the log no longer has it."""
    marker = next(
        (e for e in logs
         if (e.get("data") or {}).get("requestId") == request_id and "FAILED" in (e.get("message") or "")),
        None,
    )
    if not marker:
        return None
    marker_ts = _parse_ts(marker.get("timestamp"))
    cause = None
    if marker_ts is not None:
        for e in logs:  # newest first: the first match is the closest one before the marker
            ts = _parse_ts(e.get("timestamp"))
            if (
                ts is not None and marker_ts - _CAUSE_WINDOW_SECONDS <= ts <= marker_ts
                and e.get("level") == "error" and e.get("label") in _CAUSE_LABELS
            ):
                cause = e
                break
    if cause:
        return _cause_text(cause)
    return marker.get("message") or None


async def _failed_request_issues(base_url: str, api_key: str, take: int) -> list[dict[str, Any]]:
    """Failed requests as Issues-tab rows — Seerr doesn't count them as
    issues, but they're the problems most worth seeing."""
    data = await _get(
        base_url, api_key, f"{_API}/request",
        params={"take": take, "skip": 0, "filter": "failed", "sort": "modified", "sortDirection": "desc"},
    )
    results = [r for r in (data.get("results", []) if isinstance(data, dict) else []) if r.get("status") == _REQ_FAILED]
    if not results:
        return []
    meta, logs = await asyncio.gather(
        _meta_for(base_url, api_key, [r.get("media") or {} for r in results]),
        _recent_problem_logs(base_url, api_key),
    )
    out = []
    for r in results:
        media = r.get("media") or {}
        media_type = r.get("type") or media.get("mediaType") or ""
        m = meta.get((media.get("mediaType"), media.get("tmdbId")), {})
        reason = _failure_reason(r.get("id"), logs)
        out.append({
            "id": f"request-{r.get('id')}",
            "source": "failed_request",
            "request_id": r.get("id"),
            "issue_type": "Failed request",
            "media_type": media_type,
            "title": m.get("title", ""),
            "year": m.get("year"),
            "poster_url": m.get("poster_url", ""),
            "season": None,
            "episode": None,
            "seasons": sorted(s.get("seasonNumber") for s in (r.get("seasons") or []) if s.get("seasonNumber") is not None),
            "reported_by": _user_name(r.get("requestedBy")),
            "created_at": r.get("updatedAt") or r.get("createdAt"),
            "message": reason or "No reason recorded by Seerr (its log may have rotated)",
            "reason_found": reason is not None,
            "sent_to": "Sonarr" if media_type == "tv" else "Radarr",
        })
    return out


async def get_issues(base_url: str, api_key: str, take: int = 100) -> list[dict[str, Any]]:
    """Everything wrong on the request side, newest first: failed requests
    (with the reason from Seerr's log, when it still has it) and open
    issues users reported against titles (wrong audio, bad video, ...)."""
    data, failed = await asyncio.gather(
        _get(base_url, api_key, f"{_API}/issue", params={"take": take, "skip": 0, "filter": "open", "sort": "added"}),
        _failed_request_issues(base_url, api_key, take),
    )
    results = data.get("results", []) if isinstance(data, dict) else []
    meta = await _meta_for(base_url, api_key, [i.get("media") or {} for i in results])
    reported = []
    for i in results:
        media = i.get("media") or {}
        m = meta.get((media.get("mediaType"), media.get("tmdbId")), {})
        comments = i.get("comments") or []
        reported.append({
            "id": f"issue-{i.get('id')}",
            "source": "reported",
            "request_id": None,
            "issue_type": _ISSUE_TYPES.get(i.get("issueType"), "Other"),
            "media_type": media.get("mediaType") or "",
            "title": m.get("title", ""),
            "year": m.get("year"),
            "poster_url": m.get("poster_url", ""),
            "season": i.get("problemSeason") or None,
            "episode": i.get("problemEpisode") or None,
            "seasons": [],
            "reported_by": _user_name(i.get("createdBy")),
            "created_at": i.get("createdAt"),
            "message": (comments[0].get("message") or "") if comments else "",
            "reason_found": True,
            "sent_to": None,
        })
    rows = failed + reported
    rows.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return rows


_STATE_EVENTS = {
    "pending": "Requested", "approved": "Approved", "declined": "Declined", "failed": "Failed",
    "processing": "Processing", "partial": "Partially available", "available": "Available",
}


async def get_history(base_url: str, api_key: str, page_size: int = 50) -> list[dict[str, Any]]:
    """Requests as activity rows for the cross-service Activities log —
    each request's latest state as its event, dated when it last changed."""
    rows = await get_requests(base_url, api_key, take=page_size)
    return [
        {
            "id": r["id"],
            "event_type": _STATE_EVENTS.get(r["state"], r["state"]),
            "title": f"{r['title']} ({r['year']})" if r["year"] else r["title"],
            "source_title": None,
            "quality": "4K" if r["is_4k"] else "",
            "date": r["updated_at"] or r["requested_at"],
        }
        for r in rows
    ]


async def approve_request(base_url: str, api_key: str, request_id: int) -> None:
    await _post(base_url, api_key, f"{_API}/request/{request_id}/approve", None)


async def decline_request(base_url: str, api_key: str, request_id: int) -> None:
    await _post(base_url, api_key, f"{_API}/request/{request_id}/decline", None)


async def retry_request(base_url: str, api_key: str, request_id: int) -> None:
    """Re-send a failed request to its Sonarr/Radarr."""
    await _post(base_url, api_key, f"{_API}/request/{request_id}/retry", None)


async def delete_request(base_url: str, api_key: str, request_id: int) -> None:
    """Delete the request record itself, whatever its status — Seerr's own
    permission check allows this for any status when the caller can manage
    requests (which the API key always can). For "I don't want this any
    more" — a title that was deleted, or a request stuck stalled with
    nothing left to fix."""
    await _delete(base_url, api_key, f"{_API}/request/{request_id}")
