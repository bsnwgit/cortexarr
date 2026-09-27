"""
GET /api/tracking — where every Seerr request is in the pipeline (scope #2):
approval → sending → searching → downloading → importing → available, with
how long it's been in its stage. The logic is app/tracking.py; stalls alert
through the alert rules (the stalled_* events).
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, Depends

from app import tracking
from app.database import get_db
from app.dependencies import CurrentUser

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
