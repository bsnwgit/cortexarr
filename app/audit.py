"""
Audit log helper (scope #21) — records configuration changes: who added or
removed a monitored service, changed a threshold, edited a notification
rule. Not general request logging.
"""
from __future__ import annotations

import json
from typing import Any

import aiosqlite


async def record(
    db: aiosqlite.Connection,
    *,
    user: dict,
    action: str,
    target_type: str = "",
    target_id: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    await db.execute(
        "INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            user.get("id"),
            user.get("username", "unknown"),
            action,
            target_type,
            str(target_id),
            json.dumps(detail or {}),
        ),
    )
    await db.commit()
