"""
Cortexarr — FastAPI application entry point.

Sonarr + Radarr + Seerr + NZBGet + SABnzbd: app-level health (scope #1),
global + per-user notifications (#3, #13), audit log (#21), public status
API, and an MCP server with parity to the web UI (/mcp). Item-level flow
tracking, AI provider integration, and self-update all land in later
passes — see the project memory for the full scope list.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db, seed_admin

from app.api import auth, users, services, settings as settings_router, status as status_router, audit as audit_router
from app.api import tokens
from app.mcp import server as mcp_server

settings = get_settings()
log = logging.getLogger("cortexarr")

_PLACEHOLDER_SECRETS = {
    "secret_key": {"", "CHANGE_ME_IN_PRODUCTION_secret_key_32chars", "CHANGE_ME_generate_with_openssl_rand_hex_32"},
    "credential_key": {"", "CHANGE_ME_generate_with_fernet_generate_key"},
}
for _field, _placeholders in _PLACEHOLDER_SECRETS.items():
    if getattr(settings, _field) in _placeholders:
        raise RuntimeError(
            f"config.yaml has no real '{_field}' set (missing or still the placeholder "
            "value) — refusing to start with a publicly-known secret. Set it yourself "
            "(see config.example.yaml), or via the Docker entrypoint / install.sh."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Cortexarr starting up")
    await init_db()
    log.info("Database migrations applied")
    await seed_admin()
    log.info("Admin seed check complete")

    from app.poller import run_forever
    poller_task = asyncio.create_task(run_forever())
    app.state.poller_task = poller_task
    log.info("Health poller task started")

    yield

    log.info("Cortexarr shutting down")
    poller_task.cancel()


app = FastAPI(
    title="Cortexarr",
    description="Health and flow monitoring for a self-hosted media acquisition pipeline",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(services.router, prefix="/api/services", tags=["services"])
app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])
app.include_router(audit_router.router, prefix="/api/audit", tags=["audit"])
app.include_router(tokens.router, prefix="/api/tokens", tags=["tokens"])
# Token-authenticated, for outside AI tools — see app/mcp/server.py.
app.include_router(mcp_server.router, tags=["mcp"])
# Public, unauthenticated — see app/api/status.py's module docstring.
app.include_router(status_router.router, prefix="/api/status", tags=["status"])


@app.get("/api/health", tags=["system"])
async def health():
    return {"status": "ok", "version": "0.1.0"}


# -- Serve React frontend (production build) ---------------------------------------
_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(_frontend_dist / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        import os.path
        dist_root = os.path.normpath(str(_frontend_dist))
        candidate = os.path.normpath(os.path.join(dist_root, full_path))
        if not (candidate == dist_root or candidate.startswith(dist_root + os.sep)):
            raise HTTPException(status_code=404, detail="Not found")
        static_file = Path(candidate)
        if static_file.exists() and static_file.is_file():
            return FileResponse(str(static_file))
        return FileResponse(
            str(_frontend_dist / "index.html"),
            headers={"Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache"},
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_level=settings.log_level.lower())
