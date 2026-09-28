"""
Thin client for Radarr's v3 API — the movie counterpart to sonarr_client.py.

Same shape as the Sonarr client (same (base_url, api_key) signatures, same
ConnectivityError/ServiceApiError contract, dispatched by `service.type` in
app/api/services.py's `_DETAIL_CLIENTS`) with the transport shared through
app/services/arr_http.py. What differs is the model: a movie is one item —
no seasons or episodes — with up to three release dates (in cinemas,
digital, physical) instead of a per-episode air date.

  - get_queue / get_wanted_missing / get_calendar / get_movies / get_history
    — the read-through detail views (not cached; Radarr is the source of
    truth for its own library/queue state).
  - get_movie_detail / get_movie_history — the movie overview page.
  - set_movie_monitored / search_movie / delete_movie_file / delete_movie —
    the write paths, each admin-only and audited at the route layer.

Field names follow Radarr's published OpenAPI spec
(src/Radarr.Api.V3/openapi.json).
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import partial
from typing import Any

from app.services import arr_http
from app.services.arr_http import HealthResult
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "HealthResult",
    "test_connection", "check_health",
    "get_queue", "get_wanted_missing", "get_calendar", "get_movies", "get_history",
    "get_movie_detail", "get_movie_history",
    "set_movie_monitored", "search_movie", "delete_movie_file", "delete_movie",
    "remove_queue_item", "import_queue_item", "get_movies_progress",
]

_APP = "Radarr"

test_connection = partial(arr_http.test_connection, _APP)
check_health = partial(arr_http.check_health, _APP)
_get = partial(arr_http.get, _APP)
_put = partial(arr_http.put, _APP)
_post = partial(arr_http.post, _APP)
_delete = partial(arr_http.delete, _APP)
_cover_url = arr_http.cover_url

# (MovieResource field, label) — the three dates a movie can "air" on.
_RELEASE_DATES = (
    ("inCinemas", "In cinemas"),
    ("digitalRelease", "Digital"),
    ("physicalRelease", "Physical"),
)


def _parse_dt(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _quality_name(q: dict[str, Any] | None) -> str:
    return ((q or {}).get("quality") or {}).get("name", "")


def _release_date(m: dict[str, Any]) -> str | None:
    """The date that made (or will make) the movie available at home —
    digital first, then physical, then theatrical — for sorting and a single
    "released" column. None when Radarr has no date at all."""
    return m.get("digitalRelease") or m.get("physicalRelease") or m.get("inCinemas")


def _movie_summary(m: dict[str, Any]) -> dict[str, Any]:
    """The fields shared by the library list and the detail page."""
    movie_file = m.get("movieFile") or {}
    return {
        "id": m.get("id"),
        "title": m.get("title", ""),
        "sort_title": m.get("sortTitle") or (m.get("title") or "").lower(),
        "year": m.get("year") or None,
        "status": m.get("status"),
        "monitored": m.get("monitored", False),
        "has_file": m.get("hasFile", False),
        "is_available": m.get("isAvailable", False),
        "size_on_disk": m.get("sizeOnDisk") or 0,
        "studio": m.get("studio") or "",
        "runtime": m.get("runtime") or 0,
        "certification": m.get("certification") or "",
        "quality": _quality_name(movie_file.get("quality")) if movie_file else "",
        "in_cinemas": m.get("inCinemas"),
        "digital_release": m.get("digitalRelease"),
        "physical_release": m.get("physicalRelease"),
        "release_date": _release_date(m),
        "poster_url": _cover_url(m.get("images"), "poster"),
        "fanart_url": _cover_url(m.get("images"), "fanart"),
    }


async def get_queue(base_url: str, api_key: str, page_size: int = 50) -> list[dict[str, Any]]:
    """Currently downloading/importing. includeMovie brings each item's
    movie (title, year, artwork) inline, so the dashboard card doesn't need
    a second library-wide fetch just for posters."""
    data = await _get(
        base_url, api_key, "/api/v3/queue",
        params={"pageSize": page_size, "includeMovie": "true"},
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    out = []
    for r in records:
        size = r.get("size") or 0
        sizeleft = r.get("sizeleft") or 0
        progress = round((1 - sizeleft / size) * 100, 1) if size else None

        messages: list[str] = []
        for sm in r.get("statusMessages", []) or []:
            messages.extend(sm.get("messages", []) or [])
        if r.get("errorMessage"):
            messages.append(r["errorMessage"])

        movie = r.get("movie") or {}
        out.append({
            "id": r.get("id"),
            "movie_id": r.get("movieId"),
            "movie": movie.get("title", "") or r.get("title", ""),
            "year": movie.get("year") or None,
            "poster_url": _cover_url(movie.get("images"), "poster"),
            "fanart_url": _cover_url(movie.get("images"), "fanart"),
            "quality": _quality_name(r.get("quality")),
            "status": r.get("status"),
            "tracked_status": r.get("trackedDownloadStatus"),
            "tracked_state": r.get("trackedDownloadState"),
            "progress_pct": progress,
            "timeleft": r.get("timeleft"),
            "download_client": r.get("downloadClient"),
            "messages": messages,
            "download_id": r.get("downloadId"),
            "added": r.get("added"),
        })
    return out


async def get_wanted_missing(base_url: str, api_key: str, page_size: int = 1000) -> list[dict[str, Any]]:
    """Monitored movies that are out (isAvailable) but have no file — the
    movie equivalent of Sonarr's aired-but-missing episodes. Radarr's
    wanted/missing also returns not-yet-released films; those aren't a gap
    yet, so they're left to the Calendar rather than flagged here."""
    data = await _get(
        base_url, api_key, "/api/v3/wanted/missing",
        params={"pageSize": page_size, "monitored": "true"},
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    out = []
    for m in records:
        if not m.get("isAvailable", False):
            continue
        s = _movie_summary(m)
        out.append({
            "id": s["id"],
            "movie_id": s["id"],
            "title": s["title"],
            "year": s["year"],
            "status": s["status"],
            "release_date": s["release_date"],
            "monitored": s["monitored"],
            "poster_url": s["poster_url"],
            "fanart_url": s["fanart_url"],
        })
    return out


async def get_calendar(base_url: str, api_key: str, start: str, end: str) -> list[dict[str, Any]]:
    """Release-date events for an explicit range — one event per release
    date (cinemas/digital/physical) that falls inside it, so one movie can
    appear up to three times. Same exclusion rule as Sonarr's calendar:
    drop only "date already passed and the file is already here"."""
    data = await _get(
        base_url, api_key, "/api/v3/calendar",
        params={"start": start, "end": end},
    )
    records = data if isinstance(data, list) else []
    now = datetime.now(timezone.utc)
    out = []
    for m in records:
        has_file = m.get("hasFile", False)
        for field_name, label in _RELEASE_DATES:
            raw = m.get(field_name)
            if not raw or not (start <= raw[:10] <= end):
                continue
            dt = _parse_dt(raw)
            if has_file and dt is not None and dt < now:
                continue
            out.append({
                "id": f"{m.get('id')}-{field_name}",
                "movie_id": m.get("id"),
                "title": m.get("title", ""),
                "year": m.get("year") or None,
                "release_type": label,
                "date": raw,
                "has_file": has_file,
                "monitored": m.get("monitored", False),
            })
    return out


async def get_movies(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """The library — one row per movie for the poster-list Movies tab."""
    data = await _get(base_url, api_key, "/api/v3/movie")
    records = data if isinstance(data, list) else []
    out = [_movie_summary(m) for m in records]
    out.sort(key=lambda s: s["sort_title"])
    return out


async def get_movie_detail(base_url: str, api_key: str, movie_id: int) -> dict[str, Any]:
    """One movie for its overview page — the summary plus overview, genres,
    ratings, and the file on disk (if any)."""
    m = await _get(base_url, api_key, f"/api/v3/movie/{movie_id}")
    detail = _movie_summary(m)
    ratings = m.get("ratings") or {}
    movie_file = m.get("movieFile")
    detail.update({
        "overview": m.get("overview", ""),
        "genres": m.get("genres") or [],
        "imdb_rating": (ratings.get("imdb") or {}).get("value"),
        "tmdb_rating": (ratings.get("tmdb") or {}).get("value"),
        "imdb_id": m.get("imdbId") or "",
        "tmdb_id": m.get("tmdbId"),
        "movie_file": {
            "id": movie_file.get("id"),
            "relative_path": movie_file.get("relativePath") or "",
            "size": movie_file.get("size") or 0,
            "quality": _quality_name(movie_file.get("quality")),
            "date_added": movie_file.get("dateAdded"),
            "release_group": movie_file.get("releaseGroup") or "",
            "edition": movie_file.get("edition") or "",
        } if movie_file else None,
    })
    return detail


def _history_row(r: dict[str, Any]) -> dict[str, Any]:
    movie = r.get("movie") or {}
    return {
        "id": r.get("id"),
        "event_type": r.get("eventType"),
        "movie_id": r.get("movieId"),
        "movie": movie.get("title", ""),
        "year": movie.get("year") or None,
        "source_title": r.get("sourceTitle"),
        "quality": _quality_name(r.get("quality")),
        "date": r.get("date"),
    }


async def get_history(base_url: str, api_key: str, page_size: int = 50) -> list[dict[str, Any]]:
    """Recent grab/import/failure events, newest first."""
    data = await _get(
        base_url, api_key, "/api/v3/history",
        params={
            "pageSize": page_size, "includeMovie": "true",
            "sortKey": "date", "sortDirection": "descending",
        },
    )
    records = data.get("records", []) if isinstance(data, dict) else []
    return [_history_row(r) for r in records]


async def get_movie_history(base_url: str, api_key: str, movie_id: int) -> list[dict[str, Any]]:
    """All history for one movie — the movie page's History button."""
    data = await _get(base_url, api_key, "/api/v3/history/movie", params={"movieId": movie_id})
    records = data if isinstance(data, list) else []
    rows = [_history_row(r) for r in records]
    rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return rows


async def set_movie_monitored(base_url: str, api_key: str, movie_id: int, monitored: bool) -> None:
    """Flip one movie's monitored flag via the bulk editor endpoint, which
    only touches the fields sent — no fetch-and-replace of the whole movie
    resource the way Sonarr's series PUT needs."""
    await _put(base_url, api_key, "/api/v3/movie/editor", {"movieIds": [movie_id], "monitored": monitored})


async def search_movie(base_url: str, api_key: str, movie_id: int) -> None:
    """Trigger Radarr to search for one movie's release."""
    await _post(base_url, api_key, "/api/v3/command", {"name": "MoviesSearch", "movieIds": [movie_id]})


async def rescan_movie(base_url: str, api_key: str, movie_id: int) -> None:
    """Ask Radarr to re-check the actual file on disk — the fix for
    Radarr's own has_file/is_available believing a file exists when it's
    been moved or deleted outside Radarr's awareness (force sync with
    reality: Cortexarr has no filesystem access of its own, so the only
    honest way to verify disk state is asking Radarr to look again)."""
    await _post(base_url, api_key, "/api/v3/command", {"name": "RescanMovie", "movieIds": [movie_id]})


async def delete_movie_file(base_url: str, api_key: str, movie_file_id: int) -> None:
    """Delete the movie's file from disk via Radarr; the movie itself stays
    in the library (and shows as missing again)."""
    await _delete(base_url, api_key, f"/api/v3/moviefile/{movie_file_id}")


async def delete_movie(base_url: str, api_key: str, movie_id: int, delete_files: bool = False) -> None:
    """Remove a movie from Radarr. delete_files defaults to False — this
    only stops Radarr managing it unless the caller explicitly opts in."""
    await _delete(
        base_url, api_key, f"/api/v3/movie/{movie_id}",
        params={"deleteFiles": str(delete_files).lower(), "addImportExclusion": "false"},
    )


async def remove_queue_item(base_url: str, api_key: str, queue_id: int, blocklist: bool, search: bool) -> None:
    await arr_http.remove_queue_item(_APP, base_url, api_key, queue_id, blocklist=blocklist, search=search)


async def import_queue_item(base_url: str, api_key: str, queue_id: int) -> int:
    """Import a stuck download as the movie Radarr already matched it to.
    Returns how many files were sent to import."""
    q = await arr_http.queue_record(_APP, base_url, api_key, queue_id)
    if not q.get("downloadId"):
        raise ServiceApiError("Radarr has no download id for this item, so it can't be imported from here")
    params = {"downloadId": q["downloadId"], "filterExistingFiles": "true"}
    if q.get("movieId"):
        params["movieId"] = q["movieId"]
    preview = [i for i in await _get(base_url, api_key, "/api/v3/manualimport", params=params) if not arr_http.is_sample(i)]
    if not preview:
        raise ServiceApiError("Radarr found no files to import for this download — they may be gone, or Radarr sees "
                              "a different path than the download client (check Remote Path Mappings)")
    files = []
    for item in preview:
        movie_id = (item.get("movie") or {}).get("id") or q.get("movieId")
        if not movie_id:
            raise ServiceApiError("Radarr can't tell which movie these files are — use Interactive Import in Radarr")
        files.append({**arr_http.import_file(item), "movieId": movie_id})
    await arr_http.manual_import(_APP, base_url, api_key, files)
    return len(files)


async def get_movies_progress(base_url: str, api_key: str) -> list[dict[str, Any]]:
    """Every movie with whether it's on disk and released — what request
    tracking (app/tracking.py) needs, in one call for the whole library."""
    data = await _get(base_url, api_key, "/api/v3/movie")
    return [
        {"id": m.get("id"), "title": m.get("title", ""), "tmdb_id": m.get("tmdbId"), "added": m.get("added"),
         "has_file": bool(m.get("hasFile")), "is_available": bool(m.get("isAvailable"))}
        for m in (data if isinstance(data, list) else [])
    ]
