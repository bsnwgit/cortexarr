"""
/api/users/* — self profile, per-user notification preferences (scope #13),
and admin user management.
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr

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
    target: str = ""


_VALID_CHANNELS = {"email", "webhook", "ntfy", "sms"}


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
    await db.execute(
        "INSERT INTO user_notification_prefs (user_id, channel, enabled, target, updated_at) "
        "VALUES (?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(user_id, channel) DO UPDATE SET enabled=excluded.enabled, target=excluded.target, updated_at=excluded.updated_at",
        (user["id"], body.channel, int(body.enabled), body.target),
    )
    await db.commit()
    return {"message": "Preference saved"}


# -- Admin user management --------------------------------------------------------

class CreateUser(BaseModel):
    username: str
    email: EmailStr
    password: str
    role: str = "viewer"


_VALID_ROLES = {"admin", "analyst", "viewer"}


@router.get("/")
async def list_users(admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users ORDER BY id"
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_user(body: CreateUser, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.role not in _VALID_ROLES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown role: {body.role}")
    problem = password_problem(body.password)
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
    return {"id": cur.lastrowid, "username": body.username, "role": body.role}


class UpdateUser(BaseModel):
    role: str | None = None
    is_active: bool | None = None


@router.patch("/{user_id}")
async def update_user(user_id: int, body: UpdateUser, admin: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.role is not None and body.role not in _VALID_ROLES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unknown role: {body.role}")
    if body.role is not None:
        await db.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
    if body.is_active is not None:
        await db.execute("UPDATE users SET is_active = ? WHERE id = ?", (int(body.is_active), user_id))
    await db.commit()
    await audit.record(db, user=admin, action="user.update", target_type="user", target_id=user_id,
                        detail=body.model_dump(exclude_none=True))
    return {"message": "Updated"}
