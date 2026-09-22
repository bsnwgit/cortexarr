"""
GET /api/audit — read the configuration-change audit log (scope #21).
Admin only: who added/removed a service, changed a threshold, edited a
notification rule.
"""
from __future__ import annotations

import json

import aiosqlite
from fastapi import APIRouter, Depends

from app.database import get_db
from app.dependencies import AdminUser

router = APIRouter()


@router.get("/")
async def list_audit_log(admin: AdminUser, db: aiosqlite.Connection = Depends(get_db), limit: int = 100):
    async with db.execute(
        "SELECT id, user_id, username, action, target_type, target_id, detail, created_at "
        "FROM audit_log ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ) as cur:
        rows = await cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["detail"] = json.loads(d["detail"]) if d["detail"] else {}
        except json.JSONDecodeError:
            pass
        out.append(d)
    return out
