"""
/api/tokens — personal API tokens for the MCP endpoint (app/mcp/server.py).

A token is shown exactly once, in the answer to the request that made it,
and only its hash is stored. Everyone manages their own; an admin sees and
can revoke all of them, because a token that leaked has to be stoppable by
somebody other than its owner. Revoking deletes the row — the audit log
keeps the record of it being made and revoked.

Only an admin may make a write token (every write tool is admin-only anyway,
so a viewer's write token could do nothing), and only an admin may make one
that allows destructive tools — an outside AI tool has nobody to confirm with.
"""
from __future__ import annotations

import hashlib
import secrets
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import audit
from app.database import get_db
from app.dependencies import CurrentUser

router = APIRouter()

PREFIX = "cx_"
SHOWN_CHARS = 10          # how much of a token the list shows, to tell them apart


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class TokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    access: str = Field(default="read", pattern="^(read|write)$")
    allow_destructive: bool = False
    # 0 means it never expires.
    expires_days: int = Field(default=90, ge=0, le=3650)


_SELECT = (
    "SELECT t.id, t.user_id, u.username, t.name, t.prefix, t.access, t.allow_destructive, "
    "t.created_at, t.expires_at, t.last_used_at "
    "FROM api_tokens t JOIN users u ON u.id = t.user_id"
)


def _out(row: aiosqlite.Row) -> dict:
    d = dict(row)
    d["allow_destructive"] = bool(d["allow_destructive"])
    return d


@router.get("/")
async def list_tokens(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Your own tokens — or, for an admin, everybody's."""
    if user["role"] == "admin":
        sql, params = _SELECT + " ORDER BY u.username, t.name", ()
    else:
        sql, params = _SELECT + " WHERE t.user_id = ? ORDER BY t.name", (user["id"],)
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [_out(r) for r in rows]


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_token(body: TokenCreate, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    if body.access == "write" and user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only an admin may make a write token")
    if body.allow_destructive and body.access != "write":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="A token that allows destructive tools must allow writes too")

    token = PREFIX + secrets.token_urlsafe(32)
    expires = f"+{body.expires_days} days" if body.expires_days else None
    cur = await db.execute(
        "INSERT INTO api_tokens (user_id, name, token_hash, prefix, access, allow_destructive, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)",
        (user["id"], body.name.strip(), hash_token(token), token[:SHOWN_CHARS],
         body.access, int(body.allow_destructive), expires, expires),
    )
    await db.commit()
    await audit.record(db, user=user, action="token.create", target_type="api_token", target_id=cur.lastrowid,
                       detail={"name": body.name.strip(), "access": body.access,
                               "allow_destructive": body.allow_destructive, "expires_days": body.expires_days})
    async with db.execute(_SELECT + " WHERE t.id = ?", (cur.lastrowid,)) as got:
        row = await got.fetchone()
    # The only time the token itself is ever sent.
    return {**_out(row), "token": token}


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_token(token_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)) -> None:
    async with db.execute(_SELECT + " WHERE t.id = ?", (token_id,)) as cur:
        row: Optional[aiosqlite.Row] = await cur.fetchone()
    # Somebody else's token is "not found" rather than "forbidden", so a
    # probe can't map other people's tokens.
    if row is None or (row["user_id"] != user["id"] and user["role"] != "admin"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Token not found")
    await db.execute("DELETE FROM api_tokens WHERE id = ?", (token_id,))
    await db.commit()
    await audit.record(db, user=user, action="token.revoke", target_type="api_token", target_id=token_id,
                       detail={"name": row["name"], "owner": row["username"]})
