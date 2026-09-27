"""
/api/users/* — self profile, per-user notification preferences (scope #13),
and admin user management.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field, TypeAdapter, ValidationError

from app import audit
from app.auth.local import hash_password, password_problem, verify_password
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

router = APIRouter()


# -- Self -------------------------------------------------------------------------

@router.get("/me")
async def me(user: CurrentUser):
    return {k: v for k, v in user.items() if k != "hashed_password"}


class ChangePassword(BaseModel):
    current_password: str
    new_password: str


@router.put("/me/password")
async def change_password(body: ChangePassword, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    problem = password_problem(body.new_password)
    if problem:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)
    async with db.execute("SELECT hashed_password FROM users WHERE id = ?", (user["id"],)) as cur:
        row = await cur.fetchone()
    if not row or not verify_password(body.current_password, row["hashed_password"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect")
    await db.execute(
        "UPDATE users SET hashed_password = ? WHERE id = ?",
        (hash_password(body.new_password), user["id"]),
    )
    await db.commit()
    return {"message": "Password updated"}


# -- Per-user notification preferences (scope #13) -------------------------------

class NotificationPref(BaseModel):
    channel: str  # 'email' | 'webhook' | 'ntfy' | 'sms'
    enabled: bool
    target: str = Field(default="", max_length=500)


_VALID_CHANNELS = {"email", "webhook", "ntfy", "sms"}
_NTFY_TOPIC = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PHONE = re.compile(r"^\+[1-9]\d{6,14}$")


def _target_problem(channel: str, target: str) -> str | None:
    """Why a target can't be used for its channel, or None. Alerts are sent
    to these, so they're checked here rather than failing at 3am."""
    if channel == "email":
        try:
            TypeAdapter(EmailStr).validate_python(target)
        except ValidationError:
            return "That isn't an email address"
    elif channel == "webhook":
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return "A webhook URL starts with http:// or https://"
    elif channel == "ntfy" and not _NTFY_TOPIC.match(target):
        return "An ntfy topic is letters, numbers, - and _ (up to 64)"
    elif channel == "sms" and not _PHONE.match(target):
        return "A phone number is in international format, e.g. +15551234567"
    return None


@router.get("/me/notifications")
async def get_my_notification_prefs(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT channel, enabled, target FROM user_notification_prefs WHERE user_id = ?", (user["id"],)
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.put("/me/notifications")
async def set_my_notification_pref(body: NotificationPref, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.channel not in _VALID_CHANNELS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown channel: {body.channel}")
    target = body.target.strip()
    if body.enabled and not target:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter where to send it before turning it on")
    problem = _target_problem(body.channel, target) if target else None
    if problem:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)
    await db.execute(
        "INSERT INTO user_notification_prefs (user_id, channel, enabled, target, updated_at) "
        "VALUES (?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(user_id, channel) DO UPDATE SET enabled=excluded.enabled, target=excluded.target, updated_at=excluded.updated_at",
        (user["id"], body.channel, int(body.enabled), target),
    )
    await db.commit()
    return {"message": "Preference saved"}


class MyTest(BaseModel):
    channel: str


@router.post("/me/notifications/test")
async def test_my_notification(body: MyTest, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Send a test to your own saved address for one channel — only to it,
    not to the admin's default recipients."""
    from app.notifications.sender import Message, send

    if body.channel not in _VALID_CHANNELS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown channel: {body.channel}")
    async with db.execute(
        "SELECT target FROM user_notification_prefs WHERE user_id = ? AND channel = ?", (user["id"], body.channel),
    ) as cur:
        row = await cur.fetchone()
    if not row or not row["target"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Save where to send it first")
    text = f"Cortexarr test notification for {user['username']} — this is where your alerts will arrive."
    return await send(db, body.channel, Message(
        subject="[Cortexarr Test] Your notifications", email_body=text, title="Cortexarr Test", text=text,
    ), [row["target"]], only_extra=True)


# -- Admin user management --------------------------------------------------------
#
# A user management page (Requested features): list, add, edit role/email/
# active, reset a forgotten password, delete. The one rule enforced here
# that isn't just "admin only": an admin can never leave the instance with
# no active admin left to manage it — demoting, deactivating or deleting
# the last one is refused.

_VALID_ROLES = {"admin", "analyst", "viewer"}
_USERNAME = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")


def username_problem(username: str) -> str | None:
    if not _USERNAME.match(username):
        return "Username is 1-64 characters: letters, numbers, . _ -"
    return None


class CreateUser(BaseModel):
    username: str
    email: EmailStr
    password: str
    role: str = "viewer"


def _user_out(row: aiosqlite.Row) -> dict:
    d = dict(row)
    d["is_active"] = bool(d["is_active"])
    return d


async def _get_user(db: aiosqlite.Connection, user_id: int) -> aiosqlite.Row:
    async with db.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users WHERE id = ?", (user_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return row


async def _other_active_admins(db: aiosqlite.Connection, user_id: int) -> int:
    async with db.execute(
        "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?", (user_id,),
    ) as cur:
        return (await cur.fetchone())[0]


async def _refuse_if_last_admin(db: aiosqlite.Connection, row: aiosqlite.Row, losing_admin: bool) -> None:
    """losing_admin: true if this change would leave the user not an active
    admin (demoted, deactivated, or deleted outright)."""
    if row["role"] == "admin" and row["is_active"] and losing_admin and not await _other_active_admins(db, row["id"]):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This is the only active admin — make someone else admin first")


@router.get("/")
async def list_users(admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users ORDER BY id"
    ) as cur:
        rows = await cur.fetchall()
    return [_user_out(r) for r in rows]


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_user(body: CreateUser, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.role not in _VALID_ROLES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown role: {body.role}")
    problem = username_problem(body.username) or password_problem(body.password)
    if problem:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)
    try:
        cur = await db.execute(
            "INSERT INTO users (username, email, hashed_password, role) VALUES (?, ?, ?, ?)",
            (body.username, body.email, hash_password(body.password), body.role),
        )
        await db.commit()
    except aiosqlite.IntegrityError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
    await audit.record(db, user=admin, action="user.create", target_type="user", target_id=cur.lastrowid,
                        detail={"username": body.username, "role": body.role})
    return _user_out(await _get_user(db, cur.lastrowid))


class UpdateUser(BaseModel):
    email: EmailStr | None = None
    role: str | None = None
    is_active: bool | None = None


@router.patch("/{user_id}")
async def update_user(user_id: int, body: UpdateUser, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.role is not None and body.role not in _VALID_ROLES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown role: {body.role}")
    row = await _get_user(db, user_id)
    losing_admin = (body.role is not None and body.role != "admin") or body.is_active is False
    await _refuse_if_last_admin(db, row, losing_admin)

    if body.email is not None:
        await db.execute("UPDATE users SET email = ? WHERE id = ?", (body.email, user_id))
    if body.role is not None:
        await db.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
    if body.is_active is not None:
        await db.execute("UPDATE users SET is_active = ? WHERE id = ?", (int(body.is_active), user_id))
    await db.commit()
    await audit.record(db, user=admin, action="user.update", target_type="user", target_id=user_id,
                        detail={**body.model_dump(exclude_none=True), "username": row["username"]})
    return _user_out(await _get_user(db, user_id))


class ResetPassword(BaseModel):
    new_password: str


@router.put("/{user_id}/password")
async def reset_user_password(
    user_id: int, body: ResetPassword, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db),
):
    """An admin setting a forgotten password — no current password needed,
    unlike the self-service change. Never logs the password itself."""
    row = await _get_user(db, user_id)
    problem = password_problem(body.new_password)
    if problem:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)
    await db.execute("UPDATE users SET hashed_password = ? WHERE id = ?", (hash_password(body.new_password), user_id))
    await db.commit()
    await audit.record(db, user=admin, action="user.reset_password", target_type="user", target_id=user_id,
                        detail={"username": row["username"]})
    return {"message": "Password reset"}


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: int, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    row = await _get_user(db, user_id)
    await _refuse_if_last_admin(db, row, losing_admin=True)
    await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    await db.commit()
    await audit.record(db, user=admin, action="user.delete", target_type="user", target_id=user_id,
                        detail={"username": row["username"]})
