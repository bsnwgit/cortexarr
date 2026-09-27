"""
/api/services/* — CRUD for monitored service instances, connection testing
(scope #19), and the latest health snapshot per instance.
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field

from app import audit
from app.crypto import decrypt_str, encrypt_str
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser
from app.services import arr_http, nzbget_client, radarr_client, sabnzbd_client, seerr_client, sonarr_client
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()

_VALID_TYPES = {"sonarr", "radarr", "seerr", "nzbget", "sabnzbd"}
_MASK = "••••••••"

# Extension point for future services (scope: "build Sonarr fully, use it as
# the model"): a new type is implemented by adding a client module and one
# entry here. Each client implements the views its media model has — a
# view (or route) the client has no function for answers 404/400 rather
# than a 500, so e.g. Radarr has no "series" and Sonarr has no "movies".
_DETAIL_CLIENTS = {
    "sonarr": sonarr_client, "radarr": radarr_client, "seerr": seerr_client, "nzbget": nzbget_client,
    "sabnzbd": sabnzbd_client,
}
_IMPLEMENTED_TYPES = set(_DETAIL_CLIENTS)

# view name -> client function name. Calendar has its own route (start/end).
_DETAIL_VIEWS = {
    "queue": "get_queue",
    "wanted": "get_wanted_missing",
    "series": "get_series",
    "movies": "get_movies",
    "history": "get_history",
    "requests": "get_requests",
    "issues": "get_issues",
    "overview": "get_overview",
}


class ServiceCreate(BaseModel):
    name: str
    type: str
    base_url: str
    api_key: str = ""
    poll_interval_seconds: int = Field(default=60, ge=10)
    retry_count: int = Field(default=3, ge=0, le=10)
    retry_backoff_seconds: int = Field(default=5, ge=1)
    ingestion_mode: str = "poll"


class ServiceUpdate(BaseModel):
    name: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    enabled: Optional[bool] = None
    maintenance_mode: Optional[bool] = None
    poll_interval_seconds: Optional[int] = Field(default=None, ge=10)
    retry_count: Optional[int] = Field(default=None, ge=0, le=10)
    retry_backoff_seconds: Optional[int] = Field(default=None, ge=1)
    ingestion_mode: Optional[str] = None


def _serialize(row: aiosqlite.Row) -> dict:
    d = dict(row)
    d["api_key"] = _MASK if d.pop("api_key_enc", "") else ""
    d["enabled"] = bool(d["enabled"])
    d["maintenance_mode"] = bool(d["maintenance_mode"])
    return d


@router.get("/")
async def list_services(
    user: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
    type: Optional[str] = None,
    q: Optional[str] = None,
):
    """List monitored services. `type` and `q` (name substring) support the
    dashboard's search/filter (scope #20)."""
    sql = "SELECT * FROM service_instances WHERE 1=1"
    params: list = []
    if type:
        sql += " AND type = ?"
        params.append(type)
    if q:
        sql += " AND name LIKE ?"
        params.append(f"%{q}%")
    sql += " ORDER BY name"
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [_serialize(r) for r in rows]


@router.get("/{service_id}")
async def get_service(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return _serialize(row)


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_service(body: ServiceCreate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.type not in _VALID_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown type: {body.type}")
    if body.type not in _IMPLEMENTED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{body.type}' isn't built yet — only {sorted(_IMPLEMENTED_TYPES)} for now",
        )
    # Refuse a definite type mismatch (e.g. a Radarr URL saved as Sonarr).
    # An unreachable service still saves — it may just be down right now.
    if body.api_key:
        actual = await arr_http.detect_app(body.base_url, body.api_key)
        if not actual and await seerr_client.looks_like_seerr(body.base_url):
            actual = "Seerr"
        if actual and actual.lower() != body.type:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"That URL is a {actual} instance — set the type to {actual}",
            )
    api_key_enc = encrypt_str(body.api_key) if body.api_key else ""
    cur = await db.execute(
        "INSERT INTO service_instances "
        "(name, type, base_url, api_key_enc, poll_interval_seconds, retry_count, retry_backoff_seconds, ingestion_mode) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (body.name, body.type, body.base_url, api_key_enc, body.poll_interval_seconds,
         body.retry_count, body.retry_backoff_seconds, body.ingestion_mode),
    )
    await db.commit()
    await audit.record(db, user=admin, action="service.create", target_type="service_instance",
                        target_id=cur.lastrowid, detail={"name": body.name, "type": body.type})
    return await get_service(cur.lastrowid, admin, db)


@router.patch("/{service_id}")
async def update_service(service_id: int, body: ServiceUpdate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        existing = await cur.fetchone()
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    fields, params = [], []
    updates = body.model_dump(exclude_none=True)
    for key, value in updates.items():
        if key == "api_key":
            fields.append("api_key_enc = ?")
            params.append(encrypt_str(value) if value else "")
        elif key in ("enabled", "maintenance_mode"):
            fields.append(f"{key} = ?")
            params.append(int(value))
        else:
            fields.append(f"{key} = ?")
            params.append(value)
    if fields:
        fields.append("updated_at = datetime('now')")
        params.append(service_id)
        await db.execute(f"UPDATE service_instances SET {', '.join(fields)} WHERE id = ?", params)
        await db.commit()
        await audit.record(db, user=admin, action="service.update", target_type="service_instance",
                            target_id=service_id, detail={k: v for k, v in updates.items() if k != "api_key"})
    return await get_service(service_id, admin, db)


@router.delete("/{service_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service(service_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT name FROM service_instances WHERE id = ?", (service_id,)) as cur:
        existing = await cur.fetchone()
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await db.execute("DELETE FROM service_instances WHERE id = ?", (service_id,))
    await db.commit()
    await audit.record(db, user=admin, action="service.delete", target_type="service_instance",
                        target_id=service_id, detail={"name": existing["name"]})


class TestConnectionRequest(BaseModel):
    """Test using either a saved instance's stored key, or unsaved form values —
    covers both "test before save" and "test an existing instance" (scope #19)."""
    type: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None


def _client_for_type(service_type: Optional[str]):
    client = _DETAIL_CLIENTS.get(service_type or "")
    if not client:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{service_type}' isn't built yet — only {sorted(_DETAIL_CLIENTS)} for now",
        )
    return client


@router.post("/test-connection")
async def test_connection_unsaved(body: TestConnectionRequest, admin: AdminUser):
    client = _client_for_type(body.type)
    if not body.base_url or not body.api_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="base_url and api_key are required")
    ok, message = await client.test_connection(body.base_url, body.api_key)
    return {"ok": ok, "message": message}


@router.post("/{service_id}/test-connection")
async def test_connection_saved(service_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    client = _client_for_type(row["type"])
    api_key = decrypt_str(row["api_key_enc"])
    ok, message = await client.test_connection(row["base_url"], api_key)
    return {"ok": ok, "message": message}


@router.get("/{service_id}/health")
async def latest_health(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), limit: int = 20):
    async with db.execute(
        "SELECT id, checked_at, connectivity_ok, status, detail FROM health_snapshots "
        "WHERE service_instance_id = ? ORDER BY checked_at DESC LIMIT ?",
        (service_id, limit),
    ) as cur:
        rows = await cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["connectivity_ok"] = bool(d["connectivity_ok"])
        try:
            d["detail"] = json.loads(d["detail"]) if d["detail"] else None
        except json.JSONDecodeError:
            pass
        out.append(d)
    return out


async def _get_service_and_client(service_id: int, db: aiosqlite.Connection):
    """Shared by every route below that needs a service row plus its
    dispatched client (read or write) — one 404/400 shape instead of three
    copies of it."""
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return row, _client_for_type(row["type"])


def _client_fn(row: aiosqlite.Row, client, name: str):
    """A client function by name, or a 400 when this service type's media
    model has no such thing (e.g. seasons on Radarr, movies on Sonarr)."""
    fn = getattr(client, name, None)
    if fn is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Not supported for '{row['type']}'",
        )
    return fn


@router.get("/{service_id}/detail/{view}")
async def service_detail(
    service_id: int, view: str, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """Live, read-through detail views (queue/wanted/series/movies/history)
    behind the per-service drill-down page. Not cached — see sonarr_client's
    module docstring for why. Dispatches on `service.type` via _DETAIL_CLIENTS
    so a future service type only needs an entry there, not a new route."""
    fn_name = _DETAIL_VIEWS.get(view)
    if not fn_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown view: {view}")

    row, client = await _get_service_and_client(service_id, db)
    fn = getattr(client, fn_name, None)
    if fn is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No '{view}' view for '{row['type']}'")

    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await fn(row["base_url"], api_key)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/{service_id}/calendar")
async def service_calendar(
    service_id: int, start: str, end: str, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The Calendar tab's month grid — one page (month) at a time via
    explicit start/end (ISO dates), not a fixed relative window."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await _client_fn(row, client, "get_calendar")(row["base_url"], api_key, start, end)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


class SeriesMonitorUpdate(BaseModel):
    monitored: bool


@router.patch("/{service_id}/series/{series_id}/monitored")
async def update_series_monitored(
    service_id: int, series_id: int, body: SeriesMonitorUpdate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The Series tab's Monitored toggle — the first write path to a
    monitored service (everything else in this router only reads it).
    Admin-only and audited like the other mutating routes here."""
    row, client = await _get_service_and_client(service_id, db)

    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "set_series_monitored")(row["base_url"], api_key, series_id, body.monitored)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    await audit.record(db, user=admin, action="series.monitor", target_type="service_instance",
                        target_id=service_id, detail={"series_id": series_id, "monitored": body.monitored})
    return {"ok": True, "monitored": body.monitored}


class EpisodeMonitorUpdate(BaseModel):
    monitored: bool


@router.patch("/{service_id}/episodes/{episode_id}/monitored")
async def update_episode_monitored(
    service_id: int, episode_id: int, body: EpisodeMonitorUpdate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The Missing tab's Monitored toggle — same shape as the series one,
    but at episode granularity (Sonarr's wanted/missing rows are episodes)."""
    row, client = await _get_service_and_client(service_id, db)

    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "set_episode_monitored")(row["base_url"], api_key, episode_id, body.monitored)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    await audit.record(db, user=admin, action="episode.monitor", target_type="service_instance",
                        target_id=service_id, detail={"episode_id": episode_id, "monitored": body.monitored})
    return {"ok": True, "monitored": body.monitored}


@router.get("/{service_id}/series/{series_id}")
async def series_detail(
    service_id: int, series_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The Series tab's drill-down — one series with its season breakdown."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await _client_fn(row, client, "get_series_detail")(row["base_url"], api_key, series_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


class SeasonMonitorUpdate(BaseModel):
    monitored: bool


@router.patch("/{service_id}/series/{series_id}/seasons/{season_number}/monitored")
async def update_season_monitored(
    service_id: int, series_id: int, season_number: int, body: SeasonMonitorUpdate,
    admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The series drill-down page's per-season Monitored toggle."""
    row, client = await _get_service_and_client(service_id, db)

    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "set_season_monitored")(row["base_url"], api_key, series_id, season_number, body.monitored)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    await audit.record(db, user=admin, action="season.monitor", target_type="service_instance",
                        target_id=service_id,
                        detail={"series_id": series_id, "season_number": season_number, "monitored": body.monitored})
    return {"ok": True, "monitored": body.monitored}


@router.get("/{service_id}/series/{series_id}/seasons/{season_number}/episodes")
async def season_episodes(
    service_id: int, series_id: int, season_number: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """Episode rows for one season — fetched when its row is expanded."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await _client_fn(row, client, "get_season_episodes")(row["base_url"], api_key, series_id, season_number)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/{service_id}/series/{series_id}/seasons/{season_number}/history")
async def season_history(
    service_id: int, series_id: int, season_number: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """Season History modal's data."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await _client_fn(row, client, "get_season_history")(row["base_url"], api_key, series_id, season_number)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/{service_id}/series/{series_id}/seasons/{season_number}/search")
async def trigger_season_search(
    service_id: int, series_id: int, season_number: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The expanded season row's Search button."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "search_season")(row["base_url"], api_key, series_id, season_number)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="season.search", target_type="service_instance",
                        target_id=service_id, detail={"series_id": series_id, "season_number": season_number})
    return {"ok": True}


@router.post("/{service_id}/episodes/{episode_id}/search")
async def trigger_episode_search(
    service_id: int, episode_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """An episode row's search icon — shown in place of the trash can when
    the episode has no file yet."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "search_episode")(row["base_url"], api_key, episode_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="episode.search", target_type="service_instance",
                        target_id=service_id, detail={"episode_id": episode_id})
    return {"ok": True}


@router.delete("/{service_id}/episodefiles/{episode_file_id}")
async def delete_episode_file_route(
    service_id: int, episode_file_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """An episode row's trash-can icon — shown when the episode has a file.
    Deletes the file from disk via Sonarr; the episode itself stays (and
    reverts to showing the search icon)."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "delete_episode_file")(row["base_url"], api_key, episode_file_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="episode.delete_file", target_type="service_instance",
                        target_id=service_id, detail={"episode_file_id": episode_file_id})
    return {"ok": True}


@router.delete("/{service_id}/series/{series_id}")
async def delete_series_route(
    service_id: int, series_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db), delete_files: bool = False,
):
    """The series overview page's trash-can button. delete_files defaults
    to False — confirmed destructive by the frontend's typed-confirmation
    modal either way, but files on disk are only touched if explicitly asked."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await _client_fn(row, client, "delete_series")(row["base_url"], api_key, series_id, delete_files)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="series.delete", target_type="service_instance",
                        target_id=service_id, detail={"series_id": series_id, "delete_files": delete_files})
    return {"ok": True}


@router.get("/{service_id}/series/{series_id}/history")
async def series_history(
    service_id: int, series_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The series header's History button — every season's history in one list."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await _client_fn(row, client, "get_series_history")(row["base_url"], api_key, series_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/{service_id}/series/{series_id}/calendar")
async def series_calendar(
    service_id: int, series_id: int, start: str, end: str, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The series header's Calendar button — missing-episode calendar
    events for just this series, one month grid page at a time."""
    row, client = await _get_service_and_client(service_id, db)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await _client_fn(row, client, "get_series_calendar")(row["base_url"], api_key, series_id, start, end)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Movies (Radarr) — one item per title, no seasons/episodes. Same auth,
# audit, and 502-on-upstream-failure shape as the series routes above.
# ---------------------------------------------------------------------------

class MovieMonitorUpdate(BaseModel):
    monitored: bool


@router.get("/{service_id}/movies/{movie_id}")
async def movie_detail(
    service_id: int, movie_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The movie overview page — summary, release dates, and file on disk."""
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, "get_movie_detail")
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await fn(row["base_url"], api_key, movie_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.patch("/{service_id}/movies/{movie_id}/monitored")
async def update_movie_monitored(
    service_id: int, movie_id: int, body: MovieMonitorUpdate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The movie page's and Missing tab's Monitor toggle."""
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, "set_movie_monitored")
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key, movie_id, body.monitored)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="movie.monitor", target_type="service_instance",
                        target_id=service_id, detail={"movie_id": movie_id, "monitored": body.monitored})
    return {"ok": True, "monitored": body.monitored}


@router.post("/{service_id}/movies/{movie_id}/search")
async def trigger_movie_search(
    service_id: int, movie_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The movie page's and Missing tab's Search action."""
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, "search_movie")
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key, movie_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="movie.search", target_type="service_instance",
                        target_id=service_id, detail={"movie_id": movie_id})
    return {"ok": True}


@router.get("/{service_id}/movies/{movie_id}/history")
async def movie_history(
    service_id: int, movie_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The movie page's History button."""
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, "get_movie_history")
    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await fn(row["base_url"], api_key, movie_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.delete("/{service_id}/moviefiles/{movie_file_id}")
async def delete_movie_file_route(
    service_id: int, movie_file_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The movie page's file trash-can — deletes the file from disk via
    Radarr; the movie stays in the library and shows as missing again."""
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, "delete_movie_file")
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key, movie_file_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="movie.delete_file", target_type="service_instance",
                        target_id=service_id, detail={"movie_file_id": movie_file_id})
    return {"ok": True}


@router.delete("/{service_id}/movies/{movie_id}")
async def delete_movie_route(
    service_id: int, movie_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db), delete_files: bool = False,
):
    """The movie page's delete button. Like series delete, files on disk
    are only touched when delete_files is explicitly true."""
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, "delete_movie")
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key, movie_id, delete_files)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action="movie.delete", target_type="service_instance",
                        target_id=service_id, detail={"movie_id": movie_id, "delete_files": delete_files})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Requests (Seerr) — approve/decline a pending request, retry a failed one.
# ---------------------------------------------------------------------------

_REQUEST_ACTIONS = {"approve": "approve_request", "decline": "decline_request", "retry": "retry_request"}


@router.post("/{service_id}/requests/{request_id}/{action}")
async def request_action(
    service_id: int, request_id: int, action: str, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The Requests tab's Approve/Decline (pending requests only — the UI
    only offers them there, and Seerr refuses them otherwise) and Retry
    (failed requests)."""
    fn_name = _REQUEST_ACTIONS.get(action)
    if not fn_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown action: {action}")
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, fn_name)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key, request_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action=f"request.{action}", target_type="service_instance",
                        target_id=service_id, detail={"request_id": request_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Downloads (NZBGet) — per-item queue/history actions and global pause.
# ---------------------------------------------------------------------------

_DOWNLOAD_ACTIONS = {
    "pause": "pause_item", "resume": "resume_item", "top": "move_item_top",
    "delete": "delete_item", "retry": "retry_item",
}
_DOWNLOAD_CONTROL = {"pause": "pause_all", "resume": "resume_all"}


@router.post("/{service_id}/downloads/{item_id}/{action}")
async def download_action(
    service_id: int, action: str, admin: AdminUser,
    # NZBGet ids are ints, SABnzbd's look like SABnzbd_nzo_xxxx.
    item_id: str = Path(max_length=100, pattern=r"^[A-Za-z0-9_\-]+$"), db: aiosqlite.Connection = Depends(get_db),
):
    """Queue item Pause/Resume/Move to top/Delete (confirmed in the UI),
    and history item Retry (re-download)."""
    fn_name = _DOWNLOAD_ACTIONS.get(action)
    if not fn_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown action: {action}")
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, fn_name)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key, item_id)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action=f"download.{action}", target_type="service_instance",
                        target_id=service_id, detail={"item_id": item_id})
    return {"ok": True}


@router.post("/{service_id}/download-control/{action}")
async def download_control(
    service_id: int, action: str, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The header strip's global Pause/Resume of all downloading."""
    fn_name = _DOWNLOAD_CONTROL.get(action)
    if not fn_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown action: {action}")
    row, client = await _get_service_and_client(service_id, db)
    fn = _client_fn(row, client, fn_name)
    api_key = decrypt_str(row["api_key_enc"])
    try:
        await fn(row["base_url"], api_key)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    await audit.record(db, user=admin, action=f"downloads.{action}_all", target_type="service_instance",
                        target_id=service_id, detail={})
    return {"ok": True}
