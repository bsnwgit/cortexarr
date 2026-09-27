"""
Shared HTTP layer for the *arr clients (sonarr_client.py, radarr_client.py).

Sonarr and Radarr expose the same v3 API conventions — X-Api-Key auth,
/api/v3/system/status for a cheap "is this really the app" probe,
/api/v3/health for the app's own issue list, the same error semantics — so
the transport, error mapping, and test/health checks live here once. Each
client binds `app` (the display name used in messages) via
functools.partial, keeping its own module-level _get/_put/... names.

Error contract (unchanged from when this lived in sonarr_client.py):
  - ConnectivityError — can't reach it, timed out, key rejected, or 5xx.
    The poller records these as connectivity_ok=False (scope #8).
  - ServiceApiError — reachable, but a 4xx other than 401 for a detail call.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.services.errors import ConnectivityError, ServiceApiError


@dataclass
class HealthResult:
    connectivity_ok: bool
    status: str  # 'ok' | 'warning' | 'error' | 'unreachable'
    issues: list[dict[str, Any]] = field(default_factory=list)
    detail: str = ""


def base(base_url: str) -> str:
    return base_url.rstrip("/")


async def test_connection(app: str, base_url: str, api_key: str, timeout: float = 10.0) -> tuple[bool, str]:
    """Returns (ok, message). Used by the "test connection" UI action."""
    url = f"{base(base_url)}/api/v3/system/status"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"X-Api-Key": api_key})
        if resp.status_code == 401:
            return False, "Rejected — check the API key"
        if resp.status_code == 404:
            return False, f"Got a response, but not from {app}'s API — check the URL"
        resp.raise_for_status()
        data = resp.json()
        # Sonarr and Radarr share this endpoint and key format, so a Radarr
        # URL "passes" as Sonarr unless the app's own name is checked.
        actual = data.get("appName")
        if actual and actual.lower() != app.lower():
            return False, f"That's a {actual} instance, not {app} — set the type to {actual}"
        version = data.get("version", "unknown")
        return True, f"Connected — {app} {version}"
    except httpx.TimeoutException:
        return False, f"Timed out after {timeout:.0f}s"
    except httpx.ConnectError as exc:
        return False, f"Could not connect: {exc}"
    except httpx.HTTPStatusError as exc:
        return False, f"HTTP {exc.response.status_code}"
    except Exception as exc:  # noqa: BLE001 - surfaced to the admin as a message, not raised
        return False, f"Unexpected error: {exc}"


async def detect_app(base_url: str, api_key: str, timeout: float = 10.0) -> str | None:
    """The app's own name from system/status ("Sonarr", "Radarr"), or None
    if it can't be determined (unreachable, bad key, no appName) — callers
    only act on a definite answer."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{base(base_url)}/api/v3/system/status", headers={"X-Api-Key": api_key})
        if resp.status_code != 200:
            return None
        name = resp.json().get("appName")
        return name if isinstance(name, str) and name else None
    except Exception:  # noqa: BLE001 - "unknown" is a valid answer here
        return None


async def check_health(app: str, base_url: str, api_key: str, timeout: float = 10.0) -> HealthResult:
    """Fetch the app's own health-issue list. Raises ConnectivityError if
    it can't be reached or the key is bad — the caller (the poller) records
    that as connectivity_ok=False, not status='error'."""
    url = f"{base(base_url)}/api/v3/health"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"X-Api-Key": api_key})
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc

    if resp.status_code == 401:
        raise ConnectivityError("API key rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"{app} returned HTTP {resp.status_code}")
    resp.raise_for_status()

    issues = resp.json()
    if not isinstance(issues, list):
        issues = []

    if not issues:
        return HealthResult(connectivity_ok=True, status="ok")

    severities = {issue.get("type", "warning") for issue in issues}
    status = "error" if "error" in severities else "warning"
    summary = "; ".join(issue.get("message", "") for issue in issues[:5])
    return HealthResult(connectivity_ok=True, status=status, issues=issues, detail=summary)


def _raise_for(app: str, path: str, resp: httpx.Response) -> None:
    if resp.status_code == 401:
        raise ConnectivityError("API key rejected")
    if resp.status_code >= 500:
        raise ConnectivityError(f"{app} returned HTTP {resp.status_code}")
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise ServiceApiError(f"HTTP {exc.response.status_code} from {path}") from exc


async def _request(
    app: str, method: str, base_url: str, api_key: str, path: str,
    params: dict[str, Any] | None = None, body: Any = None, timeout: float = 15.0,
) -> httpx.Response:
    url = f"{base(base_url)}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url, headers={"X-Api-Key": api_key}, params=params, json=body)
    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        raise ConnectivityError(str(exc)) from exc
    _raise_for(app, path, resp)
    return resp


async def get(app: str, base_url: str, api_key: str, path: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> Any:
    resp = await _request(app, "GET", base_url, api_key, path, params=params, timeout=timeout)
    return resp.json()


async def put(app: str, base_url: str, api_key: str, path: str, body: Any, timeout: float = 15.0) -> Any:
    # Some PUTs (e.g. Radarr's /movie/editor) answer 202 with no body.
    resp = await _request(app, "PUT", base_url, api_key, path, body=body, timeout=timeout)
    return resp.json() if resp.content else None


async def post(app: str, base_url: str, api_key: str, path: str, body: Any, timeout: float = 15.0) -> Any:
    resp = await _request(app, "POST", base_url, api_key, path, body=body, timeout=timeout)
    return resp.json() if resp.content else None


async def delete(app: str, base_url: str, api_key: str, path: str, params: dict[str, Any] | None = None, timeout: float = 15.0) -> None:
    await _request(app, "DELETE", base_url, api_key, path, params=params, timeout=timeout)


# ---------------------------------------------------------------------------
# Queue fixes — shared by Sonarr and Radarr, whose queue and manual-import
# APIs have the same shape. Used by the Alerts page's action buttons.
# ---------------------------------------------------------------------------

async def queue_record(app: str, base_url: str, api_key: str, queue_id: int) -> dict[str, Any]:
    """One raw queue record by id (there's no GET /queue/{id})."""
    data = await get(app, base_url, api_key, "/api/v3/queue", params={"pageSize": 1000})
    for r in (data.get("records", []) if isinstance(data, dict) else []):
        if r.get("id") == queue_id:
            return r
    raise ServiceApiError(f"That item is no longer in {app}'s queue")


async def remove_queue_item(app: str, base_url: str, api_key: str, queue_id: int, *, blocklist: bool, search: bool) -> None:
    """Remove from the queue and the download client. blocklist stops the
    same release being grabbed again; search then looks for another one."""
    await delete(app, base_url, api_key, f"/api/v3/queue/{queue_id}", params={
        "removeFromClient": "true",
        "blocklist": str(blocklist).lower(),
        "skipRedownload": str(not search).lower(),
    })


async def manual_import(app: str, base_url: str, api_key: str, files: list[dict[str, Any]]) -> None:
    """The same command the app's own Interactive Import sends."""
    await post(app, base_url, api_key, "/api/v3/command", {"name": "ManualImport", "importMode": "auto", "files": files})


async def command_status(app: str, base_url: str, api_key: str, command_id: int) -> dict[str, Any]:
    """Where a command (a search, an import) the app is running has got to —
    status is queued / started / completed / failed / aborted / cancelled."""
    c = await get(app, base_url, api_key, f"/api/v3/command/{command_id}")
    return {"id": c.get("id"), "name": c.get("name"), "status": c.get("status"),
            "result": c.get("result"), "message": c.get("message") or ""}


def import_file(item: dict[str, Any]) -> dict[str, Any]:
    """The fields both apps' ManualImportFile shares, from a manualimport preview row."""
    return {
        "path": item.get("path"),
        "folderName": item.get("folderName"),
        "quality": item.get("quality"),
        "languages": item.get("languages") or [],
        "releaseGroup": item.get("releaseGroup"),
        "indexerFlags": item.get("indexerFlags") or 0,
        "downloadId": item.get("downloadId"),
    }


def is_sample(item: dict[str, Any]) -> bool:
    return any("sample" in (r.get("reason") or "").lower() for r in item.get("rejections") or [])


def cover_url(images: list[dict[str, Any]] | None, cover_type: str) -> str:
    """Prefer remoteUrl (a public CDN — thetvdb/tmdb/fanart.tv — the
    frontend can load directly) over the app's own `url`, which is a path on
    the *arr itself and would need a proxied, authenticated request to load."""
    for img in images or []:
        if img.get("coverType") == cover_type and img.get("remoteUrl"):
            return img["remoteUrl"]
    return ""
