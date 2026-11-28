"""
Client for ReelHound (natural-language search across a Plex library).

Cortexarr reads one thing from it: GET /api/v1/monitor/status, with the
read-only monitoring key an admin creates on ReelHound's Admin > Security
page, sent as a Bearer token. That reply holds counts and health only — job
counts by state, why indexing is paused, and each worker's heat problem — so
there is nothing here to act on, only to watch.

Health: Warning when any indexing job has failed or a worker reports a heat
problem. A pause is ordinary operation and stays Ok.
"""
from __future__ import annotations

from typing import Any

import httpx

from app.services import arr_http
from app.services.arr_http import HealthResult
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = ["ConnectivityError", "ServiceApiError", "HealthResult", "test_connection", "check_health", "get_overview"]

_PATH = "/api/v1/monitor/status"
_NOT_REELHOUND = "Got a response, but not from ReelHound's monitoring API — check the URL and ReelHound's version"


async def _status(base_url: str, api_key: str, timeout: float = 10.0) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{arr_http.base(base_url)}{_PATH}",
                                    headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as exc:
        raise ConnectivityError(str(exc) or "timed out") from exc
    if resp.status_code == 401:
        raise ConnectivityError("Monitoring key rejected")
    if resp.status_code == 429:
        raise ConnectivityError("ReelHound is limiting requests — try again in a minute")
    if resp.status_code >= 500:
        raise ConnectivityError(f"ReelHound returned HTTP {resp.status_code}")
    try:
        data = resp.json() if resp.status_code == 200 else None
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get("app") != "reelhound":
        raise ServiceApiError(_NOT_REELHOUND)
    return data


async def test_connection(base_url: str, api_key: str, timeout: float = 10.0) -> tuple[bool, str]:
    try:
        data = await _status(base_url, api_key, timeout)
    except ConnectivityError as exc:
        if "rejected" in str(exc):
            return False, "Rejected — check the monitoring key"
        return False, f"Could not connect: {exc}"
    except ServiceApiError as exc:
        return False, str(exc)
    return True, f"Connected — ReelHound {data.get('version', 'unknown')}"


def _issues(data: dict[str, Any]) -> list[dict[str, Any]]:
    found = []
    failed = (data.get("jobs") or {}).get("failed") or 0
    if failed:
        found.append(f"{failed} indexing job{'s' if failed != 1 else ''} failed")
    for w in data.get("workers") or []:
        if w.get("heat_problem"):
            found.append(f"Worker {w.get('name', '?')}: {w['heat_problem']}")
    return [{"type": "warning", "source": "ReelHound", "message": m} for m in found]


async def check_health(base_url: str, api_key: str, timeout: float = 10.0) -> HealthResult:
    try:
        data = await _status(base_url, api_key, timeout)
    except ServiceApiError as exc:
        return HealthResult(connectivity_ok=False, status="unreachable", detail=str(exc))
    issues = _issues(data)
    if not issues:
        return HealthResult(connectivity_ok=True, status="ok")
    return HealthResult(connectivity_ok=True, status="warning", issues=issues,
                        detail="; ".join(i["message"] for i in issues[:5]))


async def get_overview(base_url: str, api_key: str) -> dict[str, Any]:
    return await _status(base_url, api_key)
