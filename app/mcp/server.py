"""
/mcp — Cortexarr as an MCP server (scope #6b), for outside AI tools.

Streamable HTTP, answering each JSON-RPC request with a plain JSON reply;
there's nothing to push server-to-client, so GET is refused. The methods
that matter are initialize, tools/list, tools/call and ping.

A call arrives with a personal API token (app/api/tokens.py) and acts as the
token's owner. What it may do is the owner's role, narrowed by the token:

  - a read token is offered, and may call, only tools that change nothing;
  - a destructive tool is refused unless the token was explicitly allowed them;
  - the tool list shows only what's allowed, so a model isn't handed tools
    it will only be refused.

Writes land in the audit log exactly as they would from the web UI, with
the actor recorded as "<user> (MCP: <token name>)".

A request carrying an Origin header from anywhere but this host is refused:
a web page must not be able to spend a token it tricked somebody into pasting.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional
from urllib.parse import urlsplit

import aiosqlite
from fastapi import APIRouter, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from app.api.tokens import hash_token
from app.database import DB_PATH
from app.mcp.tools import BY_NAME, ROLE_RANK, TOOLS, Tool

log = logging.getLogger("cortexarr.mcp")

router = APIRouter()

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
MAX_BODY = 256 * 1024
# A whole Sonarr library can run to megabytes; a model can't use that much
# in one answer anyway, and says so rather than silently getting half.
MAX_RESULT_CHARS = 200_000
VERSION = "0.1.0"

INSTRUCTIONS = (
    "Cortexarr watches one household's media acquisition pipeline: Seerr requests, Sonarr (TV), "
    "Radarr (movies), and a Usenet download client (NZBGet or SABnzbd). Service names are labels "
    "its admin chose. Start with get_status or list_services to find service ids, then use the "
    "per-service tools. Answer from what the tools return. A result starting 'refused:' is this "
    "token or its owner's role saying no; do not retry it."
)


def _error(id_: Any, code: int, message: str) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}})


def _result(id_: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": id_, "result": result})


def _text(id_: Any, text: str, is_error: bool = False) -> JSONResponse:
    return _result(id_, {"content": [{"type": "text", "text": text}], "isError": is_error})


def _unauthorised(message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=401,
                        headers={"WWW-Authenticate": 'Bearer realm="cortexarr"'})


def _origin_ok(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True
    return urlsplit(origin).netloc.lower() == (request.headers.get("host") or "").lower()


async def _owner(db: aiosqlite.Connection, request: Request) -> tuple[Optional[dict], Optional[dict], str]:
    """The token's owner as a user dict (the shape get_current_user returns),
    the token row, or why not."""
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None, None, "An API token is needed: Authorization: Bearer <token>"
    async with db.execute(
        "SELECT t.id AS token_id, t.name AS token_name, t.access, t.allow_destructive, "
        "(t.expires_at IS NOT NULL AND t.expires_at <= datetime('now')) AS expired, "
        "u.id, u.username, u.email, u.role, u.is_active, u.created_at, u.last_login "
        "FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?",
        (hash_token(header[7:].strip()),),
    ) as cur:
        row = await cur.fetchone()
    # One answer for every way a token can be wrong, so a probe learns nothing.
    if row is None or row["expired"] or not row["is_active"]:
        return None, None, "That token is not valid"
    user = {k: row[k] for k in ("id", "username", "email", "role", "is_active", "created_at", "last_login")}
    user["account"] = row["username"]
    user["token_name"] = row["token_name"]
    # What the audit log records as the actor for anything this call changes.
    user["username"] = f"{row['username']} (MCP: {row['token_name']})"[:128]
    token = {"id": row["token_id"], "access": row["access"], "allow_destructive": bool(row["allow_destructive"])}
    return user, token, ""


def _refusal(tool: Tool, user: dict, token: dict) -> str:
    """Why this token may not call this tool, or '' if it may."""
    if ROLE_RANK.get(user["role"], -1) < ROLE_RANK[tool.min_role]:
        return f"refused: {tool.name} needs the {tool.min_role} role; this account is {user['role']}"
    if tool.kind != "read" and token["access"] == "read":
        return f"refused: this token is read-only and {tool.name} changes something"
    if tool.kind == "destructive" and not token["allow_destructive"]:
        return f"refused: {tool.name} deletes something, and this token isn't allowed destructive tools"
    return ""


def _render(value: Any) -> str:
    if value is None:
        return "ok"
    text = json.dumps(jsonable_encoder(value), separators=(",", ":"), ensure_ascii=False)
    if len(text) > MAX_RESULT_CHARS:
        return (text[:MAX_RESULT_CHARS]
                + f"\n…truncated: the full result is {len(text)} characters. Narrow the request.")
    return text


async def _call(db: aiosqlite.Connection, user: dict, token: dict, params: dict) -> tuple[str, bool]:
    name = str(params.get("name") or "")
    tool = BY_NAME.get(name)
    if tool is None:
        return f"Unknown tool {name!r}", True
    # The list only offered what's allowed, but a client may call anything
    # by name — so the same rules apply again here.
    why = _refusal(tool, user, token)
    if why:
        return why, True
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        return "arguments must be an object", True
    try:
        args = tool.args.model_validate(arguments)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'arguments'}: {e['msg']}"
                             for e in exc.errors())
        return f"invalid arguments: {problems}", True
    try:
        return _render(await tool.run(db, user, args)), False
    except HTTPException as exc:
        return f"error: {exc.detail}", True
    except Exception:
        log.exception("MCP tool %s failed", name)
        return "error: the tool failed — see the Cortexarr log for detail", True


@router.get("/mcp")
async def no_stream() -> Response:
    # There's nothing to push, so there's no stream to open.
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("/mcp")
async def mcp(request: Request) -> Response:
    if not _origin_ok(request):
        return JSONResponse({"error": "Requests from a web page on another site are refused"}, status_code=403)
    raw = await request.body()
    if len(raw) > MAX_BODY:
        return _error(None, -32600, "Request too large")
    try:
        message = json.loads(raw or b"{}")
    except ValueError:
        return _error(None, -32700, "Not valid JSON")
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or "method" not in message:
        return _error(None, -32600, "Not a JSON-RPC 2.0 request")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys=ON")
        await db.execute("PRAGMA busy_timeout=5000")

        user, token, why = await _owner(db, request)
        if user is None:
            return _unauthorised(why)

        # Recorded at most once a minute, so a busy client doesn't write on every call.
        await db.execute(
            "UPDATE api_tokens SET last_used_at = datetime('now') "
            "WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))",
            (token["id"],),
        )
        await db.commit()

        method = message["method"]
        id_ = message.get("id")
        params = message.get("params") or {}
        if id_ is None:
            # A notification — notifications/initialized and the like — wants no answer.
            return Response(status_code=202)
        if not isinstance(params, dict):
            return _error(id_, -32602, "params must be an object")

        if method == "initialize":
            asked = str(params.get("protocolVersion") or "")
            return _result(id_, {
                "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "cortexarr", "version": VERSION},
                "instructions": INSTRUCTIONS,
            })

        if method == "ping":
            return _result(id_, {})

        if method == "tools/list":
            return _result(id_, {"tools": [
                {
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.input_schema(),
                    "annotations": {
                        "readOnlyHint": t.kind == "read",
                        "destructiveHint": t.kind == "destructive",
                    },
                }
                for t in TOOLS if not _refusal(t, user, token)
            ]})

        if method == "tools/call":
            text, is_error = await _call(db, user, token, params)
            return _text(id_, text, is_error)

        return _error(id_, -32601, f"Method not found: {method}")
