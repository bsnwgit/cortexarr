"""
/api/services/* — CRUD for monitored service instances, connection testing
(scope #19), and the latest health snapshot per instance.
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import audit
from app.crypto import decrypt_str, encrypt_str
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser
from app.services import sonarr_client
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()

_VALID_TYPES = {"sonarr", "radarr", "seerr", "nzbget", "sabnzbd"}
_IMPLEMENTED_TYPES = {"sonarr"}  # only type with a real client behind it so far
_MASK = "••••••••"

# Extension point for future services (scope: "build Sonarr fully, use it as
# the model"): a new type is implemented by adding a client module with the
# same get_queue/get_wanted_missing/get_calendar/get_series/get_history
# function names and one entry here — the route and dispatch below don't change.
_DETAIL_CLIENTS = {"sonarr": sonarr_client}
_DETAIL_VIEWS = {"queue", "wanted", "calendar", "series", "history"}


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


@router.post("/test-connection")
async def test_connection_unsaved(body: TestConnectionRequest, admin: AdminUser):
    if body.type != "sonarr":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only 'sonarr' is implemented so far")
    if not body.base_url or not body.api_key:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="base_url and api_key are required")
    ok, message = await sonarr_client.test_connection(body.base_url, body.api_key)
    return {"ok": ok, "message": message}


@router.post("/{service_id}/test-connection")
async def test_connection_saved(service_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if row["type"] != "sonarr":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only 'sonarr' is implemented so far")
    api_key = decrypt_str(row["api_key_enc"])
    ok, message = await sonarr_client.test_connection(row["base_url"], api_key)
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


@router.get("/{service_id}/detail/{view}")
async def service_detail(
    service_id: int, view: str, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
):
    """Live, read-through detail views (queue/wanted/calendar/series/history)
    behind the per-service drill-down page. Not cached — see sonarr_client's
    module docstring for why. Dispatches on `service.type` via _DETAIL_CLIENTS
    so a future service type only needs an entry there, not a new route."""
    if view not in _DETAIL_VIEWS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown view: {view}")

    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    client = _DETAIL_CLIENTS.get(row["type"])
    if not client:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{row['type']}' isn't built yet — only {sorted(_DETAIL_CLIENTS)} for now",
        )

    fn = {
        "queue": client.get_queue,
        "wanted": client.get_wanted_missing,
        "calendar": client.get_calendar,
        "series": client.get_series,
        "history": client.get_history,
    }[view]

    api_key = decrypt_str(row["api_key_enc"])
    try:
        return await fn(row["base_url"], api_key)
    except (ConnectivityError, ServiceApiError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
