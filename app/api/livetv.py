"""
/api/livetv/{service_id}/* — control surface for a Dispatcharr instance
(the "Live TV" page). Separate from /api/services/*, which is the
media-pipeline drill-down: nothing here is a view onto the download chain.

Roles: viewers read, analysts act (refresh, enable/disable, edit, stop a
stream), admins change what feeds Dispatcharr (M3U accounts, EPG sources —
including their credentials) and delete. Whatever the configured Dispatcharr
user is allowed to do is the ceiling; a refusal comes back as its own reason.
"""
from __future__ import annotations

from typing import Any, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app import audit
from app.crypto import decrypt_str
from app.database import get_db
from app.dependencies import AdminUser, AnalystUser, CurrentUser
from app.services import dispatcharr_client as dc
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()


async def _instance(service_id: int, db: aiosqlite.Connection) -> tuple[aiosqlite.Row, str]:
    async with db.execute("SELECT * FROM service_instances WHERE id = ?", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row or row["type"] != "dispatcharr":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a Dispatcharr service")
    return row, decrypt_str(row["api_key_enc"])


async def _run(coro):
    try:
        return await coro
    except ConnectivityError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    except ServiceApiError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


async def _audit(db: aiosqlite.Connection, user: dict, action: str, row: aiosqlite.Row, detail: dict[str, Any]) -> None:
    await audit.record(db, user=user, action=action, target_type="service_instance",
                       target_id=row["id"], detail={"service": row["name"], **detail})


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------

@router.get("/{service_id}/overview")
async def overview(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    return await _run(dc.get_overview(row["base_url"], secret))


@router.get("/{service_id}/channels")
async def channels(
    service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
    search: str = Query("", max_length=100), group: Optional[int] = None,
    profile: Optional[int] = None,
):
    row, secret = await _instance(service_id, db)
    return await _run(dc.list_channels(row["base_url"], secret, page=page, page_size=page_size,
                                       search=search, group=group, profile=profile))


@router.get("/{service_id}/channels/ids")
async def channel_ids(
    service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db),
    search: str = Query("", max_length=100), group: Optional[int] = None,
    profile: Optional[int] = None,
):
    """All channel ids matching the filter — behind "select all N matching"."""
    row, secret = await _instance(service_id, db)
    ids = await _run(dc.list_channel_ids(row["base_url"], secret, search=search, group=group, profile=profile))
    return {"count": len(ids), "ids": ids}


@router.get("/{service_id}/groups")
async def groups(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    return await _run(dc.list_groups(row["base_url"], secret))


@router.get("/{service_id}/profiles")
async def profiles(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    return await _run(dc.list_profiles(row["base_url"], secret))


@router.get("/{service_id}/streams")
async def streams(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    return await _run(dc.get_active_streams(row["base_url"], secret))


@router.get("/{service_id}/m3u")
async def m3u_accounts(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    return await _run(dc.list_m3u_accounts(row["base_url"], secret))


@router.get("/{service_id}/epg")
async def epg_sources(service_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    return await _run(dc.list_epg_sources(row["base_url"], secret))


# ---------------------------------------------------------------------------
# Channels — analyst
# ---------------------------------------------------------------------------

class ChannelEnable(BaseModel):
    profile_id: int
    channel_ids: list[int] = Field(min_length=1, max_length=20000)
    enabled: bool


@router.post("/{service_id}/channels/enable")
async def set_enabled(service_id: int, body: ChannelEnable, user: AnalystUser,
                      db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.set_channels_enabled(row["base_url"], secret, body.profile_id, body.channel_ids, body.enabled))
    await _audit(db, user, "livetv.channels_enable" if body.enabled else "livetv.channels_disable", row,
                 {"profile_id": body.profile_id, "channels": len(body.channel_ids)})
    return {"ok": True, "changed": len(body.channel_ids)}


@router.patch("/{service_id}/channels/{channel_id}")
async def edit_channel(service_id: int, channel_id: int, body: dict[str, Any], user: AnalystUser,
                       db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    out = await _run(dc.update_channel(row["base_url"], secret, channel_id, body))
    await _audit(db, user, "livetv.channel_edit", row, {"channel_id": channel_id, "fields": sorted(body)})
    return out


# ---------------------------------------------------------------------------
# Refresh + streams — analyst
# ---------------------------------------------------------------------------

@router.post("/{service_id}/m3u/refresh")
async def refresh_all_m3u(service_id: int, user: AnalystUser, db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.refresh_m3u(row["base_url"], secret))
    await _audit(db, user, "livetv.m3u_refresh", row, {"account": "all"})
    return {"ok": True}


@router.post("/{service_id}/m3u/{account_id}/refresh")
async def refresh_one_m3u(service_id: int, account_id: int, user: AnalystUser,
                          db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.refresh_m3u(row["base_url"], secret, account_id))
    await _audit(db, user, "livetv.m3u_refresh", row, {"account": account_id})
    return {"ok": True}


@router.post("/{service_id}/epg/{source_id}/refresh")
async def refresh_epg(service_id: int, source_id: int, user: AnalystUser,
                      db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.refresh_epg(row["base_url"], secret, source_id))
    await _audit(db, user, "livetv.epg_refresh", row, {"source": source_id})
    return {"ok": True}


@router.post("/{service_id}/streams/{channel_id}/stop")
async def stop_stream(service_id: int, channel_id: str, user: AnalystUser,
                      db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.stop_channel(row["base_url"], secret, channel_id))
    await _audit(db, user, "livetv.stream_stop", row, {"channel": channel_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# M3U accounts + EPG sources — admin (they carry provider credentials)
# ---------------------------------------------------------------------------

@router.post("/{service_id}/m3u", status_code=status.HTTP_201_CREATED)
async def add_m3u(service_id: int, body: dict[str, Any], admin: AdminUser,
                  db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    out = await _run(dc.create_m3u_account(row["base_url"], secret, body))
    await _audit(db, admin, "livetv.m3u_create", row, {"name": body.get("name")})
    return out


@router.patch("/{service_id}/m3u/{account_id}")
async def edit_m3u(service_id: int, account_id: int, body: dict[str, Any], admin: AdminUser,
                   db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    out = await _run(dc.update_m3u_account(row["base_url"], secret, account_id, body))
    await _audit(db, admin, "livetv.m3u_update", row,
                 {"account": account_id, "fields": sorted(k for k in body if k != "password")})
    return out


@router.delete("/{service_id}/m3u/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_m3u(service_id: int, account_id: int, admin: AdminUser,
                     db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.delete_m3u_account(row["base_url"], secret, account_id))
    await _audit(db, admin, "livetv.m3u_delete", row, {"account": account_id})


@router.post("/{service_id}/epg", status_code=status.HTTP_201_CREATED)
async def add_epg(service_id: int, body: dict[str, Any], admin: AdminUser,
                  db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    out = await _run(dc.create_epg_source(row["base_url"], secret, body))
    await _audit(db, admin, "livetv.epg_create", row, {"name": body.get("name")})
    return out


@router.patch("/{service_id}/epg/{source_id}")
async def edit_epg(service_id: int, source_id: int, body: dict[str, Any], admin: AdminUser,
                   db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    out = await _run(dc.update_epg_source(row["base_url"], secret, source_id, body))
    await _audit(db, admin, "livetv.epg_update", row,
                 {"source": source_id, "fields": sorted(k for k in body if k != "password")})
    return out


@router.delete("/{service_id}/epg/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_epg(service_id: int, source_id: int, admin: AdminUser,
                     db: aiosqlite.Connection = Depends(get_db)):
    row, secret = await _instance(service_id, db)
    await _run(dc.delete_epg_source(row["base_url"], secret, source_id))
    await _audit(db, admin, "livetv.epg_delete", row, {"source": source_id})
