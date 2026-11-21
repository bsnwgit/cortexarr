"""
/api/duplicates/* — duplicate movie and episode files found by each Sonarr and
Radarr service's own scan (app/duplicates.py, rules in
app/services/duplicate_scan.py). The scan runs on the poller and feeds the
'duplicate' alert event; these routes are the Duplicates page's and the
Dashboard pills': what the last scans found, scan now, test a scan's settings,
and delete an extra copy.

Delete is the only thing here that removes anything, so it is admin-only and
narrow: the file must be one the last scan listed under a finding that still
has two or more files, so the last copy can never be removed this way, and a
path can't be made up. A file with no S##E## in its name is never deletable —
it isn't known to be a copy of anything.
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import audit, duplicates
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser
from app.services import duplicate_scan
from app.services.errors import ConnectivityError, ServiceApiError

router = APIRouter()


class DeleteRequest(BaseModel):
    key: str = Field(min_length=1, max_length=1000, description="The finding's key, from GET /api/duplicates")
    path: str = Field(min_length=1, max_length=4000, description="One of that finding's files")


class TestRequest(BaseModel):
    duplicate_scan: dict = Field(description="The scan settings to try, as in a service's duplicate_scan")


async def _service(db: aiosqlite.Connection, service_id: int) -> aiosqlite.Row:
    async with db.execute(
        "SELECT * FROM service_instances WHERE id = ? AND type IN ('sonarr', 'radarr')", (service_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such Sonarr or Radarr service")
    return row


@router.get("/")
async def list_duplicates(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), service_id: Optional[int] = None):
    """Every scanning service, when it was last scanned, and every duplicate
    found. `counts` is findings per service, for the Dashboard pills."""
    async with db.execute(
        "SELECT s.*, l.scanned_at, l.files_seen, l.seconds, l.error "
        "FROM service_instances s LEFT JOIN library_scans l ON l.service_instance_id = s.id "
        "WHERE s.type IN ('sonarr', 'radarr') ORDER BY s.name",
    ) as cur:
        rows = [r for r in await cur.fetchall() if duplicates.config_of(r)["enabled"]]
    if service_id is not None:
        rows = [r for r in rows if r["id"] == service_id]
    by_id = {r["id"]: r for r in rows}

    services = [{
        "id": r["id"], "name": r["name"], "type": r["type"], "maintenance_mode": bool(r["maintenance_mode"]),
        "enabled": bool(r["enabled"]), "scanned_at": r["scanned_at"], "files_seen": r["files_seen"],
        "seconds": r["seconds"], "error": r["error"] or "", "scanning": duplicates.scanning(r["id"]),
    } for r in rows]

    findings: list[dict] = []
    if by_id:
        async with db.execute(
            f"SELECT * FROM duplicate_findings WHERE service_instance_id IN ({', '.join('?' for _ in by_id)}) "
            "ORDER BY title", tuple(by_id),
        ) as cur:
            found = await cur.fetchall()
        ids = {sid: await duplicates.folder_ids(by_id[sid]) for sid in {f["service_instance_id"] for f in found}}
        for f in found:
            svc = by_id[f["service_instance_id"]]
            files = json.loads(f["files"] or "[]")
            folder = duplicates.folder_of(files, duplicates.config_of(svc)["paths"])
            findings.append({
                "service_id": svc["id"], "service_name": svc["name"], "service_type": svc["type"],
                "key": f["key"], "kind": f["kind"], "title": f["title"], "reason": f["reason"], "files": files,
                "deletable": len(files) >= 2, "first_seen": f["first_seen"],
                # The series/movie in the service itself, when it can be matched by its folder.
                "target_id": ids[svc["id"]].get(folder),
            })
    counts: dict[int, int] = {}
    for f in findings:
        counts[f["service_id"]] = counts.get(f["service_id"], 0) + 1
    return {"services": services, "findings": findings, "counts": counts}


@router.post("/test")
async def test_settings(body: TestRequest, admin: AdminUser):
    """Log in with these (possibly unsaved) settings and check each folder exists, without scanning."""
    ok, message = await duplicate_scan.test_connection(body.duplicate_scan)
    return {"ok": ok, "message": message}


@router.post("/{service_id}/scan", status_code=status.HTTP_202_ACCEPTED)
async def scan_now(service_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Start this service's scan now instead of waiting for its interval. It
    runs in the background and can take minutes; the page shows 'scanning'."""
    svc = await _service(db, service_id)
    if not duplicates.config_of(svc)["enabled"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Duplicate scanning is off for this service")
    if not svc["enabled"] or svc["maintenance_mode"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This service is disabled or in maintenance mode")
    started = duplicates.start(svc)
    await audit.record(db, user=admin, action="duplicates.scan", target_type="service_instance",
                       target_id=service_id, detail={"name": svc["name"], "started": started})
    return {"started": started, "scanning": True}


@router.post("/{service_id}/delete")
async def delete_duplicate(
    service_id: int, body: DeleteRequest, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    svc = await _service(db, service_id)
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
        await duplicate_scan.delete_file(svc["duplicate_scan"], body.path)
    except ConnectivityError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Could not reach the file machine: {exc}")
    except (ServiceApiError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    remaining = [f for f in files if f != body.path]
    if len(remaining) >= 2:
        await db.execute("UPDATE duplicate_findings SET files = ? WHERE service_instance_id = ? AND key = ?",
                         (json.dumps(remaining), service_id, body.key))
    else:
        # One copy left: it's no longer a duplicate. The alert clears (and says
        # so, for rules that sent it) at the service's next check.
        await db.execute("DELETE FROM duplicate_findings WHERE service_instance_id = ? AND key = ?",
                         (service_id, body.key))
    await db.commit()
    await audit.record(db, user=admin, action="duplicate.delete", target_type="service_instance",
                       target_id=service_id, detail={"service": svc["name"], "title": finding["title"], "path": body.path})
    return {"deleted": body.path, "remaining": remaining if len(remaining) >= 2 else []}
