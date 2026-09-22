"""
POST /api/auth/* — login, logout, token refresh.
"""
from __future__ import annotations

import time

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.auth.local import verify_password, create_access_token, create_refresh_token, decode_refresh_token
from app.database import get_db

router = APIRouter()

# -- Login throttle --------------------------------------------------------------
# Per-process, in-memory backoff against password spraying / credential
# stuffing. Caps failed attempts per (client IP, username) within a rolling
# window.
_LOGIN_MAX_FAILURES = 5
_LOGIN_WINDOW = 300.0  # seconds
_login_failures: dict[str, list[float]] = {}


def _throttle_key(request: Request, username: str) -> str:
    ip = request.client.host if request.client else "?"
    return f"{ip}:{username.strip().lower()}"


def _login_locked(key: str) -> bool:
    now = time.time()
    recent = [t for t in _login_failures.get(key, []) if now - t < _LOGIN_WINDOW]
    _login_failures[key] = recent
    return len(recent) >= _LOGIN_MAX_FAILURES


def _record_login_failure(key: str) -> None:
    _login_failures.setdefault(key, []).append(time.time())


def _clear_login_failures(key: str) -> None:
    _login_failures.pop(key, None)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, response: Response, db: aiosqlite.Connection = Depends(get_db)):
    throttle_key = _throttle_key(request, body.username)
    if _login_locked(throttle_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Try again in a few minutes.",
        )

    async with db.execute(
        "SELECT id, hashed_password, role, is_active FROM users WHERE username = ? OR email = ?",
        (body.username, body.username),
    ) as cur:
        user = await cur.fetchone()

    if not user or not user["is_active"] or not verify_password(body.password, user["hashed_password"]):
        _record_login_failure(throttle_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    _clear_login_failures(throttle_key)
    await db.execute("UPDATE users SET last_login = datetime('now') WHERE id = ?", (user["id"],))
    await db.commit()

    access_token = create_access_token(user["id"], user["role"])
    refresh_token = create_refresh_token(user["id"])

    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )

    return TokenResponse(access_token=access_token, role=user["role"])


@router.post("/refresh", response_model=TokenResponse)
async def refresh(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    user_id = decode_refresh_token(token)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    async with db.execute("SELECT id, role, is_active FROM users WHERE id = ?", (user_id,)) as cur:
        user = await cur.fetchone()

    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    access_token = create_access_token(user["id"], user["role"])
    return TokenResponse(access_token=access_token, role=user["role"])


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}
