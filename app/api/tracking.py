"""
GET /api/tracking — where every Seerr request is in the pipeline (scope #2):
approval → sending → searching → downloading → importing → available, with
how long it's been in its stage. The logic is app/tracking.py; stalls alert
through the alert rules (the stalled_* events).

Also carries each request's `mismatch` flag (scope: force sync with
reality) — Seerr says available, but Sonarr/Radarr is still searching and
hasn't actually found anything — and the one-click fix for it. And
`orphaned` — nothing in Sonarr/Radarr matches this request at all any
more; its fix (Clear) is the existing request-clear route in
app/api/services.py, reused as-is.
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, Depends

from app import audit, tracking
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

router = APIRouter()


@router.get("/")
async def request_tracking(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), active_only: bool = True):
    """Every request's stage. active_only (the default) leaves out finished
    ones — available, and failed, which the Alerts page covers."""
    result = await tracking.track(db)
    if active_only:
        result["requests"] = [t for t in result["requests"] if t["stage"] not in ("available", "failed")]
    result["stages"] = [{"key": k, "label": tracking.STAGE_LABELS[k]} for k in tracking.STAGES]
    return result


@router.post("/{seerr_id}/requests/{request_id}/search")
async def search_mismatched_request(
    seerr_id: int, request_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """The Tracking page's fix for a mismatch: Seerr says available, reality
    says still searching. Same action as the Alerts page's stalled_searching
    fix (app/tracking.py's search_request), just reachable directly from
    where the mismatch is actually noticed, without waiting for a rule's
    threshold to make it a "current problem" first."""
    result = await tracking.search_request(db, admin, seerr_id, request_id)
    await audit.record(db, user=admin, action="request.search", target_type="service_instance",
                       target_id=seerr_id, detail={"request_id": request_id, "searched": result.get("searched")})
    return result
