"""
/api/alerts/* — alert rules (scope #3: user-defined which problems notify, at
what threshold, through which channels), the problems currently seen, and
the log of alerts sent. The engine that applies the rules is
app/notifications/engine.py, run by the poller.

Anyone signed in can see rules, current problems, and the log; changing
rules is admin-only and audited, like every other configuration change.
Snoozing a problem (scope #9) is an operational action, so analysts can too.
"""
from __future__ import annotations

import json
from typing import Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import audit
from app.database import get_db
from app.dependencies import AdminUser, AnalystUser, CurrentUser
from app.notifications import engine
from app.notifications.advice import ACTIONS, DESTRUCTIVE, diagnose

router = APIRouter()

Event = Literal["unreachable", "error", "warning", "stuck", "download_failed", "request_issue",
                "stalled_approval", "stalled_sending", "stalled_searching", "stalled_downloading", "stalled_importing"]
Channel = Literal["email", "webhook", "ntfy", "sms"]


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = True
    event: Event
    service_id: Optional[int] = Field(default=None, description="Omit for every service")
    threshold_minutes: int = Field(default=0, ge=0, le=10080)
    repeat_minutes: int = Field(default=0, ge=0, le=10080, description="Remind every N minutes while it lasts; 0 = once")
    channels: list[Channel] = Field(min_length=1)
    notify_resolved: bool = True


class RuleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    enabled: Optional[bool] = None
    event: Optional[Event] = None
    # Explicit null means "every service", so presence is tracked separately.
    service_id: Optional[int] = None
    all_services: Optional[bool] = Field(default=None, description="true to apply to every service")
    threshold_minutes: Optional[int] = Field(default=None, ge=0, le=10080)
    repeat_minutes: Optional[int] = Field(default=None, ge=0, le=10080)
    channels: Optional[list[Channel]] = Field(default=None, min_length=1)
    notify_resolved: Optional[bool] = None


def _rule_out(row: aiosqlite.Row) -> dict:
    d = dict(row)
    d["enabled"] = bool(d["enabled"])
    d["notify_resolved"] = bool(d["notify_resolved"])
    d["channels"] = json.loads(d["channels"] or "[]")
    return d


async def _check_service(db: aiosqlite.Connection, service_id: Optional[int]) -> None:
    if service_id is None:
        return
    async with db.execute("SELECT 1 FROM service_instances WHERE id = ?", (service_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"No service with id {service_id}")


async def _get_rule(db: aiosqlite.Connection, rule_id: int) -> aiosqlite.Row:
    async with db.execute("SELECT * FROM alert_rules WHERE id = ?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found")
    return row


@router.get("/rules")
async def list_rules(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM alert_rules ORDER BY name") as cur:
        return [_rule_out(r) for r in await cur.fetchall()]


@router.post("/rules", status_code=status.HTTP_201_CREATED)
async def create_rule(body: RuleIn, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    await _check_service(db, body.service_id)
    cur = await db.execute(
        "INSERT INTO alert_rules (name, enabled, event, service_id, threshold_minutes, repeat_minutes, channels, notify_resolved) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (body.name.strip(), int(body.enabled), body.event, body.service_id, body.threshold_minutes,
         body.repeat_minutes, json.dumps(sorted(set(body.channels))), int(body.notify_resolved)),
    )
    await db.commit()
    await audit.record(db, user=admin, action="alert_rule.create", target_type="alert_rule",
                       target_id=cur.lastrowid, detail=body.model_dump())
    return _rule_out(await _get_rule(db, cur.lastrowid))


@router.patch("/rules/{rule_id}")
async def update_rule(rule_id: int, body: RuleUpdate, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    await _get_rule(db, rule_id)
    changes = body.model_dump(exclude_none=True)
    all_services = changes.pop("all_services", None)
    fields, params = [], []
    if all_services:
        fields.append("service_id = NULL")
        changes.pop("service_id", None)
    elif "service_id" in changes:
        await _check_service(db, changes["service_id"])
    for key, value in changes.items():
        if key == "channels":
            value = json.dumps(sorted(set(value)))
        elif key in ("enabled", "notify_resolved"):
            value = int(value)
        elif key == "name":
            value = value.strip()
        fields.append(f"{key} = ?")
        params.append(value)
    if fields:
        fields.append("updated_at = datetime('now')")
        await db.execute(f"UPDATE alert_rules SET {', '.join(fields)} WHERE id = ?", (*params, rule_id))
        # A changed rule starts fresh: what it already said about the old
        # event or scope doesn't carry over.
        if {"event", "service_id"} & changes.keys() or all_services:
            await db.execute("DELETE FROM alert_notified WHERE rule_id = ?", (rule_id,))
        await db.commit()
        await audit.record(db, user=admin, action="alert_rule.update", target_type="alert_rule",
                           target_id=rule_id, detail=body.model_dump(exclude_none=True))
    return _rule_out(await _get_rule(db, rule_id))


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(rule_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    row = await _get_rule(db, rule_id)
    await db.execute("DELETE FROM alert_rules WHERE id = ?", (rule_id,))
    await db.commit()
    await audit.record(db, user=admin, action="alert_rule.delete", target_type="alert_rule",
                       target_id=rule_id, detail={"name": row["name"]})


@router.post("/rules/{rule_id}/test")
async def test_rule(rule_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Send what this rule's alert looks like, through its channels, now."""
    rule = await _get_rule(db, rule_id)
    service_name = "Example service"
    if rule["service_id"] is not None:
        async with db.execute("SELECT name FROM service_instances WHERE id = ?", (rule["service_id"],)) as cur:
            row = await cur.fetchone()
        service_name = row["name"] if row else service_name
    results = await engine.deliver(db, rule, rule["service_id"], service_name, rule["event"], "test",
                                   await engine.sample_message(db, rule, service_name))
    await db.commit()
    return {"results": results}


@router.get("/active")
async def active_problems(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """What the engine currently sees as wrong, per service, oldest first."""
    async with db.execute(
        "SELECT c.service_instance_id AS service_id, s.name AS service_name, s.type AS service_type, "
        "s.base_url AS service_url, c.key, c.event, c.title, c.detail, c.first_seen, c.last_seen, "
        "z.until AS snoozed_until, z.note AS snooze_note, z.username AS snoozed_by, "
        "(z.key IS NOT NULL AND (z.until IS NULL OR z.until > datetime('now'))) AS snoozed "
        "FROM alert_conditions c JOIN service_instances s ON s.id = c.service_instance_id "
        "LEFT JOIN alert_snoozes z ON z.service_instance_id = c.service_instance_id AND z.key = c.key "
        "ORDER BY c.first_seen",
    ) as cur:
        rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["snoozed"] = bool(r["snoozed"])
        if not r["snoozed"]:
            # An expired snooze is history, not state.
            r["snoozed_until"] = r["snooze_note"] = r["snoozed_by"] = None
        r.update(diagnose(r))
    return rows


class FixIn(BaseModel):
    service_id: int
    key: str = Field(min_length=1, max_length=200, description="The problem's key, from active problems")
    action: Literal["import", "redownload", "remove", "retry_download", "retry_request", "test_connection",
                    "approve_request", "search_request", "clear_request"]


FixAction = Literal["import", "redownload", "remove", "retry_download", "retry_request", "test_connection",
                    "approve_request", "search_request", "clear_request"]
_QUEUE_FIXES = {"import", "remove", "redownload"}


async def _problem(db: aiosqlite.Connection, service_id: int, key: str) -> Optional[aiosqlite.Row]:
    async with db.execute(
        "SELECT c.*, s.type AS service_type, s.name AS service_name FROM alert_conditions c "
        "JOIN service_instances s ON s.id = c.service_instance_id "
        "WHERE c.service_instance_id = ? AND c.key = ?", (service_id, key),
    ) as cur:
        return await cur.fetchone()


async def _apply(db: aiosqlite.Connection, admin: dict, row: aiosqlite.Row, action: str):
    """Run one offered fix through the route the rest of the web UI uses, so
    it's audited there."""
    from app.api import services as svc

    offered = {a["id"] for a in diagnose(dict(row))["actions"]}
    if action not in offered:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"'{ACTIONS[action][0]}' doesn't apply to this problem")
    sid, key = row["service_instance_id"], row["key"]
    ref = key.split(":", 1)[1] if ":" in key else ""
    if action in _QUEUE_FIXES:
        return await svc.queue_action(sid, int(ref), action, admin, db)
    if action == "retry_download":
        return await svc.download_action(service_id=sid, action="retry", admin=admin, item_id=ref, db=db)
    if action == "retry_request":
        return await svc.request_action(sid, int(ref.removeprefix("request-")), "retry", admin, db)
    if action == "approve_request":
        return await svc.request_action(sid, int(ref.split(":")[0]), "approve", admin, db)
    if action == "search_request":
        from app import tracking
        return await tracking.search_request(db, admin, sid, int(ref.split(":")[0]))
    if action == "clear_request":
        # Same ref parsing whichever kind of key this came from:
        # "issue:request-123" -> ref "request-123"; "track:123:stage" -> ref "123:stage".
        return await svc.request_action(sid, int(ref.removeprefix("request-").split(":")[0]), "clear", admin, db)
    return await svc.test_connection_saved(sid, admin, db)


@router.post("/fix")
async def fix(body: FixIn, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Apply one of a current problem's suggested fixes."""
    row = await _problem(db, body.service_id, body.key)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such current problem — it may have cleared")
    return await _apply(db, admin, row, body.action)


class ProblemRef(BaseModel):
    service_id: int
    key: str = Field(min_length=1, max_length=200)


class BulkFixIn(BaseModel):
    items: list[ProblemRef] = Field(min_length=1, max_length=500)
    action: FixAction


@router.post("/fix/bulk")
async def fix_bulk(body: BulkFixIn, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    """Apply one fix to many problems, one at a time, and say how each went.

    Several stuck queue items can be one download (a season pack is a queue
    item per episode). A queue fix acts on the whole download, so it runs
    once per download and the rest are reported as covered by it."""
    from app.api import services as svc

    # Only problems with the same fixes can be resolved together — a bulk
    # action is one decision, and it has to mean the same thing for each.
    fix_sets = set()
    for item in body.items:
        row = await _problem(db, item.service_id, item.key)
        if row:
            fix_sets.add(tuple(a["id"] for a in diagnose(dict(row))["actions"]))
    if len(fix_sets) > 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="These problems have different fixes — resolve each kind separately")

    download_of: dict[tuple[int, int], str] = {}   # (service, queue id) -> download id
    if body.action in _QUEUE_FIXES:
        for sid in {i.service_id for i in body.items}:
            try:
                queue = await svc.service_detail(sid, "queue", admin, db)
            except HTTPException:
                continue  # each item then reports its own failure
            for q in queue:
                if q.get("download_id"):
                    download_of[(sid, q["id"])] = q["download_id"]

    done_downloads: dict[tuple[int, str], str] = {}
    results = []
    for item in body.items:
        row = await _problem(db, item.service_id, item.key)
        out = {"service_id": item.service_id, "key": item.key, "title": row["title"] if row else ""}
        if not row:
            results.append({**out, "status": "skipped", "detail": "Already cleared"})
            continue
        ref = item.key.split(":", 1)[1] if ":" in item.key else ""
        download = download_of.get((item.service_id, int(ref))) if body.action in _QUEUE_FIXES and ref.isdigit() else None
        if download and (item.service_id, download) in done_downloads:
            results.append({**out, "status": "ok", "detail": f"Same download as {done_downloads[(item.service_id, download)]}"})
            continue
        try:
            res = await _apply(db, admin, row, body.action)
        except HTTPException as exc:
            results.append({**out, "status": "failed", "detail": str(exc.detail)})
            continue
        if download:
            done_downloads[(item.service_id, download)] = row["title"]
        detail = f"{res['files']} file{'' if res['files'] == 1 else 's'}" if isinstance(res, dict) and "files" in res else ""
        if isinstance(res, dict) and res.get("ok") is False:
            results.append({**out, "status": "failed", "detail": res.get("message") or "Failed"})
        else:
            results.append({**out, "status": "ok", "detail": detail})
    return {"results": results,
            "ok": sum(r["status"] == "ok" for r in results),
            "failed": sum(r["status"] == "failed" for r in results),
            "skipped": sum(r["status"] == "skipped" for r in results)}


class SnoozeIn(BaseModel):
    service_id: int
    key: str = Field(min_length=1, max_length=200, description="The problem's key, from active problems")
    # None = acknowledged: silent until the problem clears.
    minutes: Optional[int] = Field(default=None, ge=1, le=525600, description="Omit to acknowledge until it clears")
    note: str = Field(default="", max_length=500)


@router.post("/snooze")
async def snooze(body: SnoozeIn, user: AnalystUser, db: aiosqlite.Connection = Depends(get_db)):
    """Silence one current problem — for a while, or until it clears. It
    still shows as a current problem; it just doesn't alert or remind."""
    async with db.execute(
        "SELECT title FROM alert_conditions WHERE service_instance_id = ? AND key = ?", (body.service_id, body.key),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such current problem — it may have cleared")
    until = None if body.minutes is None else f"+{body.minutes} minutes"
    await db.execute(
        "INSERT INTO alert_snoozes (service_instance_id, key, until, note, user_id, username) "
        "VALUES (?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END, ?, ?, ?) "
        "ON CONFLICT(service_instance_id, key) DO UPDATE SET until = excluded.until, note = excluded.note, "
        "user_id = excluded.user_id, username = excluded.username, created_at = datetime('now')",
        (body.service_id, body.key, until, until, body.note.strip(), user["id"], user["username"]),
    )
    await db.commit()
    await audit.record(db, user=user, action="alert.snooze" if body.minutes else "alert.acknowledge",
                       target_type="service_instance", target_id=body.service_id,
                       detail={"key": body.key, "title": row["title"], "minutes": body.minutes, "note": body.note})
    return {"ok": True}


@router.delete("/snooze")
async def unsnooze(service_id: int, key: str, user: AnalystUser, db: aiosqlite.Connection = Depends(get_db)):
    cur = await db.execute(
        "DELETE FROM alert_snoozes WHERE service_instance_id = ? AND key = ?", (service_id, key[:200]),
    )
    await db.commit()
    if cur.rowcount:
        await audit.record(db, user=user, action="alert.unsnooze", target_type="service_instance",
                           target_id=service_id, detail={"key": key})
    return {"ok": True, "removed": bool(cur.rowcount)}


@router.get("/log")
async def alert_log(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db), limit: int = 100):
    limit = max(1, min(limit, 1000))
    async with db.execute("SELECT * FROM alert_log ORDER BY id DESC LIMIT ?", (limit,)) as cur:
        rows = await cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["results"] = json.loads(d["results"] or "{}")
        out.append(d)
    return out


class BulkSnoozeIn(BaseModel):
    items: list[ProblemRef] = Field(min_length=1, max_length=500)
    minutes: Optional[int] = Field(default=None, ge=1, le=525600, description="Omit to acknowledge until each clears")
    note: str = Field(default="", max_length=500)


@router.post("/snooze/bulk")
async def snooze_bulk(body: BulkSnoozeIn, user: AnalystUser, db: aiosqlite.Connection = Depends(get_db)):
    """Snooze (or acknowledge) many current problems at once — like bulk
    fixes, only problems that share the same fixes."""
    fix_sets = set()
    for item in body.items:
        row = await _problem(db, item.service_id, item.key)
        if row:
            fix_sets.add(tuple(a["id"] for a in diagnose(dict(row))["actions"]))
    if len(fix_sets) > 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="These problems have different fixes — snooze each kind separately")
    results = []
    for item in body.items:
        try:
            await snooze(SnoozeIn(service_id=item.service_id, key=item.key, minutes=body.minutes, note=body.note), user, db)
            results.append({"service_id": item.service_id, "key": item.key, "status": "ok", "detail": ""})
        except HTTPException as exc:
            results.append({"service_id": item.service_id, "key": item.key, "status": "skipped", "detail": str(exc.detail)})
    return {"results": results, "ok": sum(r["status"] == "ok" for r in results)}

