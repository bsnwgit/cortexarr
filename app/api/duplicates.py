"""
/api/duplicates/* — duplicate movie and episode files found by scanning a
library over SSH (app/services/library_client.py). The scan runs on the
poller and feeds the 'duplicate' alert event; these routes are the Duplicates
panel's: what the last scan found, scan now, and delete an extra copy.

Delete is the only thing here that removes anything, so it is admin-only and
narrow: the file must be one the last scan listed under a finding that still
has two or more files, so the last copy can never be removed this way, and a
path can't be made up. A file with no S##E## in its name is never deletable —
it isn't known to be a copy of anything.
"""
from __future__ import annotations

import json

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import audit, poller
from app.crypto import decrypt_str
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser
from app.services import library_client
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()


class DeleteRequest(BaseModel):
    key: str = Field(min_length=1, max_length=1000, description="The finding's key, from GET /api/duplicates")
    path: str = Field(min_length=1, max_length=4000, description="One of that finding's files")


async def _library(db: aiosqlite.Connection, service_id: int) -> aiosqlite.Row:
    async with db.execute("SELECT * FROM service_instances WHERE id = ? AND type = 'library'", (service_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such library")
    return row


@router.get("/")
async def list_duplicates(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Every library, when it was last scanned, and every duplicate it holds."""
    async with db.execute(
        "SELECT s.id, s.name, s.enabled, s.maintenance_mode, l.scanned_at, l.files_seen, l.seconds, "
        "(SELECT status FROM health_snapshots h WHERE h.service_instance_id = s.id ORDER BY checked_at DESC LIMIT 1) "
        "AS health "
        "FROM service_instances s LEFT JOIN library_scans l ON l.service_instance_id = s.id "
        "WHERE s.type = 'library' ORDER BY s.name",
    ) as cur:
        libraries = [dict(r) for r in await cur.fetchall()]
    for lib in libraries:
        lib["enabled"], lib["maintenance_mode"] = bool(lib["enabled"]), bool(lib["maintenance_mode"])
        lib["scanning"] = poller.library_scanning(lib["id"])

    async with db.execute(
        "SELECT f.*, s.name AS service_name FROM duplicate_findings f "
        "JOIN service_instances s ON s.id = f.service_instance_id ORDER BY s.name, f.kind, f.title",
    ) as cur:
        rows = await cur.fetchall()
    findings = []
    for r in rows:
        files = json.loads(r["files"] or "[]")
        findings.append({
            "service_id": r["service_instance_id"], "service_name": r["service_name"], "key": r["key"],
            "kind": r["kind"], "title": r["title"], "reason": r["reason"], "files": files,
            "deletable": len(files) >= 2, "first_seen": r["first_seen"],
        })
    return {"libraries": libraries, "findings": findings}


@router.post("/{service_id}/scan", status_code=status.HTTP_202_ACCEPTED)
async def scan_now(service_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Start a scan now instead of waiting for the next poll. It runs in the
    background and can take minutes; the panel shows 'scanning' until it ends."""
    lib = await _library(db, service_id)
    if not lib["enabled"] or lib["maintenance_mode"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This library is disabled or in maintenance mode")
    started = poller.start_library_check(lib)
    await audit.record(db, user=admin, action="library.scan", target_type="service_instance",
                       target_id=service_id, detail={"name": lib["name"], "started": started})
    return {"started": started, "scanning": True}


@router.post("/{service_id}/delete")
async def delete_duplicate(
    service_id: int, body: DeleteRequest, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    lib = await _library(db, service_id)
    async with db.execute(
        "SELECT * FROM duplicate_findings WHERE service_instance_id = ? AND key = ?", (service_id, body.key),
    ) as cur:
        finding = await cur.fetchone()
    if not finding:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That duplicate is no longer listed — scan again")
    files = json.loads(finding["files"] or "[]")
    if len(files) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This isn't a pair of copies, so nothing here can be deleted — rename the file instead")
    if body.path not in files:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That file isn't part of this duplicate")

    try:
        await library_client.delete_file(lib["base_url"], decrypt_str(lib["api_key_enc"]), body.path)
    except ConnectivityError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Could not reach the library: {exc}")
    except ServiceApiError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    remaining = [f for f in files if f != body.path]
    if len(remaining) >= 2:
        await db.execute("UPDATE duplicate_findings SET files = ? WHERE service_instance_id = ? AND key = ?",
                         (json.dumps(remaining), service_id, body.key))
    else:
        # One copy left: it's no longer a duplicate. The alert clears (and says
        # so, for rules that sent it) on the next scan.
        await db.execute("DELETE FROM duplicate_findings WHERE service_instance_id = ? AND key = ?",
                         (service_id, body.key))
    await db.commit()
    await audit.record(db, user=admin, action="duplicate.delete", target_type="service_instance",
                       target_id=service_id, detail={"library": lib["name"], "title": finding["title"], "path": body.path})
    return {"deleted": body.path, "remaining": remaining if len(remaining) >= 2 else []}
