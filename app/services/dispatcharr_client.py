"""
Thin client for Dispatcharr's REST API (/api/schema/ on the instance) — the
live-TV side of the suite. It sits beside the media pipeline, not inside it:
nothing here feeds request tracking or the download views.

Dispatcharr differs from the *arrs and the download clients in two ways that
shape this module:

  - Auth: two ways, chosen per service. Either an API key, sent as the
    X-API-Key header like the *arrs (stored as "api key:<key>" — a Dispatcharr
    username can't contain a space, so the prefix can't be a real login); or
    a username/password, stored as "username:password" (same shape as NZBGet),
    which Dispatcharr exchanges for a short-lived JWT pair
    (POST /api/accounts/token/). Logins happen on demand; tokens are cached
    per (url, user) and renewed — refresh token first, a fresh login if that
    fails — when a call comes back 401.
  - Permissions: whatever the configured Dispatcharr user may do is all
    Cortexarr can do. A 403 from Dispatcharr surfaces as a ServiceApiError
    with its own reason, not as an outage.

Writes are limited to an allow-list of fields per resource, so a Cortexarr
request can't set anything the page doesn't offer.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.services.arr_http import HealthResult, base
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "HealthResult",
    "test_connection", "check_health", "get_overview",
    "list_channels", "list_channel_ids", "list_groups", "list_profiles", "update_channel",
    "set_channels_enabled",
    "list_m3u_accounts", "create_m3u_account", "update_m3u_account", "delete_m3u_account", "refresh_m3u",
    "list_epg_sources", "create_epg_source", "update_epg_source", "delete_epg_source", "refresh_epg",
    "get_active_streams", "stop_channel",
]

_APP = "Dispatcharr"

# Fields a Cortexarr write may set — everything else in a body is dropped.
_CHANNEL_FIELDS = {"name", "channel_number", "channel_group_id", "tvg_id", "epg_data_id", "logo_id",
                   "stream_profile_id", "is_adult", "hidden_from_output"}
_M3U_FIELDS = {"name", "server_url", "file_path", "account_type", "username", "password", "max_streams",
               "is_active", "refresh_interval", "cron_expression", "user_agent", "priority",
               "stale_stream_days", "enable_vod"}
_EPG_FIELDS = {"name", "source_type", "url", "username", "password", "is_active", "file_path",
               "refresh_interval", "cron_expression", "priority"}

# (base url, username) -> {"access": str, "refresh": str}
_tokens: dict[tuple[str, str], dict[str, str]] = {}


_KEY_PREFIX = "api key:"


def _api_key(secret: str) -> str | None:
    """The API key when the credential is in key mode, else None."""
    return (secret or "")[len(_KEY_PREFIX):].strip() if (secret or "").startswith(_KEY_PREFIX) else None


def _credentials(secret: str) -> tuple[str, str]:
    username, _, password = (secret or "").partition(":")
    return username, password


def _pick(body: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    return {k: v for k, v in body.items() if k in allowed}


def _detail(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}"
    if isinstance(data, dict):
        for key in ("detail", "error", "message"):
            if data.get(key):
                return str(data[key])
        return "; ".join(f"{k}: {v}" for k, v in list(data.items())[:3]) or f"HTTP {resp.status_code}"
    return f"HTTP {resp.status_code}"


async def _login(client: httpx.AsyncClient, root: str, secret: str) -> str:
    username, password = _credentials(secret)
    if not username or not password:
        raise ConnectivityError("Username and password are required")
    try:
        resp = await client.post(f"{root}/api/accounts/token/", json={"username": username, "password": password})
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc
    if resp.status_code in (400, 401, 403):
        raise ConnectivityError("Username or password rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"{_APP} returned HTTP {resp.status_code}")
    try:
        data = resp.json()
        access = data["access"]
    except (ValueError, KeyError, TypeError) as exc:
        raise ServiceApiError("Response wasn't Dispatcharr's login") from exc
    _tokens[(root, username)] = {"access": access, "refresh": str(data.get("refresh") or "")}
    return access


async def _renew(client: httpx.AsyncClient, root: str, secret: str) -> str:
    """A fresh access token: the refresh token if it still works, else a login."""
    username, _ = _credentials(secret)
    refresh = _tokens.get((root, username), {}).get("refresh")
    if refresh:
        try:
            resp = await client.post(f"{root}/api/accounts/token/refresh/", json={"refresh": refresh})
            if resp.status_code == 200 and resp.json().get("access"):
                access = resp.json()["access"]
                _tokens[(root, username)]["access"] = access
                return access
        except (httpx.HTTPError, ValueError):
            pass
    return await _login(client, root, secret)


async def _call(base_url: str, secret: str, method: str, path: str, *,
                params: dict[str, Any] | None = None, body: Any = None, timeout: float = 20.0) -> Any:
    root = base(base_url)
    key = _api_key(secret)
    if key is not None and not key:
        raise ConnectivityError("API key is required")
    username, _ = _credentials(secret)
    async with httpx.AsyncClient(timeout=timeout) as client:
        token = "" if key is not None else (
            _tokens.get((root, username), {}).get("access") or await _login(client, root, secret)
        )
        for attempt in (0, 1):
            headers = {"X-API-Key": key} if key is not None else {"Authorization": f"Bearer {token}"}
            try:
                resp = await client.request(method, f"{root}{path}", params=params, json=body, headers=headers)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                raise ConnectivityError(str(exc)) from exc
            if resp.status_code == 401 and attempt == 0 and key is None:
                token = await _renew(client, root, secret)
                continue
            break
    if resp.status_code == 401:
        raise ConnectivityError("API key rejected" if key is not None else "Username or password rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"{_APP} returned HTTP {resp.status_code}")
    if resp.status_code == 403:
        raise ServiceApiError(f"Not allowed for this Dispatcharr user — {_detail(resp)}")
    if resp.status_code >= 400:
        raise ServiceApiError(_detail(resp))
    if not resp.content:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _rows(data: Any) -> list[dict[str, Any]]:
    """List endpoints answer a bare array or a {count, results} page."""
    if isinstance(data, dict):
        data = data.get("results", [])
    return [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []


# ---------------------------------------------------------------------------
# Connection + health
# ---------------------------------------------------------------------------

async def test_connection(base_url: str, secret: str, timeout: float = 10.0) -> tuple[bool, str]:
    try:
        v = await _call(base_url, secret, "GET", "/api/core/version/", timeout=timeout)
        version = v.get("version") if isinstance(v, dict) else None
        return True, f"Connected — {_APP} {version}" if version else f"Connected — {_APP}"
    except ConnectivityError as exc:
        if "rejected" in str(exc) or "required" in str(exc):
            return False, str(exc)
        return False, f"Could not connect: {exc}"
    except ServiceApiError as exc:
        return False, f"Got a response, but not from {_APP}'s API — {exc}"


async def check_health(base_url: str, secret: str, timeout: float = 10.0) -> HealthResult:
    """Reachable + logged in is 'ok'; an M3U account or EPG source Dispatcharr
    itself marks as errored is a warning. Raises ConnectivityError when it
    can't be reached or the login is rejected."""
    try:
        accounts, sources = await asyncio.gather(
            _call(base_url, secret, "GET", "/api/m3u/accounts/", timeout=timeout),
            _call(base_url, secret, "GET", "/api/epg/sources/", timeout=timeout),
        )
    except ServiceApiError as exc:
        raise ConnectivityError(str(exc)) from exc

    issues: list[dict[str, Any]] = []
    for a in _rows(accounts):
        if a.get("is_active") and a.get("status") == "error":
            issues.append({"type": "warning", "message": f"M3U account '{a.get('name')}': {a.get('last_message') or 'refresh failed'}"})
    for s in _rows(sources):
        if s.get("is_active") and s.get("status") == "error":
            issues.append({"type": "warning", "message": f"EPG source '{s.get('name')}': {s.get('last_message') or 'refresh failed'}"})
    if not issues:
        return HealthResult(connectivity_ok=True, status="ok")
    return HealthResult(connectivity_ok=True, status="warning", issues=issues,
                        detail="; ".join(i["message"] for i in issues[:5]))


async def get_overview(base_url: str, secret: str) -> dict[str, Any]:
    version, channels, accounts, sources, streams = await asyncio.gather(
        _call(base_url, secret, "GET", "/api/core/version/"),
        _call(base_url, secret, "GET", "/api/channels/channels/", params={"page_size": 1}),
        _call(base_url, secret, "GET", "/api/m3u/accounts/"),
        _call(base_url, secret, "GET", "/api/epg/sources/"),
        get_active_streams(base_url, secret),
    )
    acc, src = _rows(accounts), _rows(sources)
    return {
        "version": (version or {}).get("version") if isinstance(version, dict) else None,
        "channel_count": channels.get("count", 0) if isinstance(channels, dict) else 0,
        "m3u_accounts": len(acc),
        "m3u_errors": sum(1 for a in acc if a.get("status") == "error"),
        "epg_sources": len(src),
        "epg_errors": sum(1 for s in src if s.get("status") == "error"),
        "active_streams": streams["count"],
    }


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------

async def list_channels(base_url: str, secret: str, *, page: int = 1, page_size: int = 50,
                        search: str = "", group: int | None = None,
                        profile: int | None = None) -> dict[str, Any]:
    """`profile` narrows to the channels enabled in that channel profile —
    Dispatcharr's own `channel_profile_id` filter (its default, without
    `show_disabled`, is enabled-only)."""
    params: dict[str, Any] = {"page": page, "page_size": page_size}
    if profile is not None:
        params["channel_profile_id"] = profile
    if search:
        params["search"] = search
    if group is not None:
        params["channel_group"] = group
    data = await _call(base_url, secret, "GET", "/api/channels/channels/", params=params)
    return {"count": data.get("count", 0) if isinstance(data, dict) else 0, "results": _rows(data)}


_ID_PAGE = 200
_ID_CAP = 20000


async def list_channel_ids(base_url: str, secret: str, *, search: str = "",
                           group: int | None = None, profile: int | None = None) -> list[int]:
    """Every channel id matching a search/group — for "select all N matching"
    across pages. Walks the list endpoint page by page, capped so a runaway
    count can't hold the request open."""
    ids: list[int] = []
    page = 1
    while len(ids) < _ID_CAP:
        data = await list_channels(base_url, secret, page=page, page_size=_ID_PAGE, search=search,
                                   group=group, profile=profile)
        rows = data["results"]
        ids.extend(int(r["id"]) for r in rows if isinstance(r.get("id"), int))
        if len(rows) < _ID_PAGE or len(ids) >= data["count"]:
            break
        page += 1
    return ids[:_ID_CAP]


async def list_groups(base_url: str, secret: str) -> list[dict[str, Any]]:
    return _rows(await _call(base_url, secret, "GET", "/api/channels/groups/"))


async def list_profiles(base_url: str, secret: str) -> list[dict[str, Any]]:
    return _rows(await _call(base_url, secret, "GET", "/api/channels/profiles/"))


async def update_channel(base_url: str, secret: str, channel_id: int, body: dict[str, Any]) -> dict[str, Any]:
    fields = _pick(body, _CHANNEL_FIELDS)
    if not fields:
        raise ServiceApiError("Nothing to change")
    return await _call(base_url, secret, "PATCH", f"/api/channels/channels/{int(channel_id)}/", body=fields)


async def set_channels_enabled(base_url: str, secret: str, profile_id: int,
                               channel_ids: list[int], enabled: bool) -> None:
    """Enable/disable channels within one channel profile (Dispatcharr's
    notion of "on" — a channel is on or off per profile)."""
    # Sent in slices so a very large selection isn't one enormous request.
    for i in range(0, len(channel_ids), 500):
        await _call(
            base_url, secret, "PATCH", f"/api/channels/profiles/{int(profile_id)}/channels/bulk-update/",
            body={"channels": [{"channel_id": int(c), "enabled": bool(enabled)} for c in channel_ids[i:i + 500]]},
            timeout=60.0,
        )


# ---------------------------------------------------------------------------
# M3U accounts + EPG sources
# ---------------------------------------------------------------------------

async def list_m3u_accounts(base_url: str, secret: str) -> list[dict[str, Any]]:
    return [_without_password(a) for a in _rows(await _call(base_url, secret, "GET", "/api/m3u/accounts/"))]


def _without_password(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if "password" in out:
        out["password"] = "••••••••" if out["password"] else ""
    return out


async def create_m3u_account(base_url: str, secret: str, body: dict[str, Any]) -> dict[str, Any]:
    return _without_password(await _call(base_url, secret, "POST", "/api/m3u/accounts/", body=_pick(body, _M3U_FIELDS)))


async def update_m3u_account(base_url: str, secret: str, account_id: int, body: dict[str, Any]) -> dict[str, Any]:
    fields = _pick(body, _M3U_FIELDS)
    # The masked value the list returned must never be written back as the password.
    if fields.get("password") == "••••••••":
        fields.pop("password")
    return _without_password(await _call(base_url, secret, "PATCH", f"/api/m3u/accounts/{int(account_id)}/", body=fields))


async def delete_m3u_account(base_url: str, secret: str, account_id: int) -> None:
    await _call(base_url, secret, "DELETE", f"/api/m3u/accounts/{int(account_id)}/")


async def refresh_m3u(base_url: str, secret: str, account_id: int | None = None) -> None:
    path = "/api/m3u/refresh/" if account_id is None else f"/api/m3u/refresh/{int(account_id)}/"
    await _call(base_url, secret, "POST", path)


async def list_epg_sources(base_url: str, secret: str) -> list[dict[str, Any]]:
    return [_without_password(s) for s in _rows(await _call(base_url, secret, "GET", "/api/epg/sources/"))]


async def create_epg_source(base_url: str, secret: str, body: dict[str, Any]) -> dict[str, Any]:
    return _without_password(await _call(base_url, secret, "POST", "/api/epg/sources/", body=_pick(body, _EPG_FIELDS)))


async def update_epg_source(base_url: str, secret: str, source_id: int, body: dict[str, Any]) -> dict[str, Any]:
    fields = _pick(body, _EPG_FIELDS)
    if fields.get("password") == "••••••••":
        fields.pop("password")
    return _without_password(await _call(base_url, secret, "PATCH", f"/api/epg/sources/{int(source_id)}/", body=fields))


async def delete_epg_source(base_url: str, secret: str, source_id: int) -> None:
    await _call(base_url, secret, "DELETE", f"/api/epg/sources/{int(source_id)}/")


async def refresh_epg(base_url: str, secret: str, source_id: int) -> None:
    await _call(base_url, secret, "POST", "/api/epg/import/", body={"id": int(source_id)})


# ---------------------------------------------------------------------------
# Streams
# ---------------------------------------------------------------------------

async def get_active_streams(base_url: str, secret: str) -> dict[str, Any]:
    """Channels with live viewers right now. The status endpoint's schema is
    undocumented ("No response body"), so the shape is read defensively: a
    {"channels": [...]} object or a bare list; each row passed through as-is
    for the page to pick known keys from."""
    data = await _call(base_url, secret, "GET", "/proxy/ts/status")
    rows = data.get("channels") if isinstance(data, dict) else data
    rows = [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
    return {"count": len(rows), "channels": rows}


async def stop_channel(base_url: str, secret: str, channel_id: str) -> None:
    """Stops a channel's stream and disconnects everyone watching it. The
    path parameter is a string; the id comes from get_active_streams rows."""
    if not channel_id or "/" in channel_id:
        raise ServiceApiError("Invalid channel id")
    await _call(base_url, secret, "POST", f"/proxy/ts/stop/{channel_id}")
