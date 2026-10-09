"""
Self-update (scope #16): checks bsnw's Cortexarr GitHub releases against the
local VERSION and, in 'auto' mode inside the configured window, downloads
and applies a newer release, then exits so systemd (Restart=always — see
cortexarr.service) brings the new code back up.

'manual' mode (the default) only ever reads — it records what's available
so Settings → General can show it, and never touches a file on disk.

There is no code signing upstream: this trusts GitHub's TLS and nothing
else, same as any other HTTPS download. Applying is refused outright on an
install that looks like a git checkout (a `.git` directory in install_dir)
— that's a dev/working tree, not the kind of hands-off install this is
for, and overwriting it would silently clobber uncommitted work.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Optional

import aiosqlite
import httpx

from app.config import get_settings
from app.database import DB_PATH

log = logging.getLogger("cortexarr.self_update")

REPO = "bsnwgit/cortexarr"
_RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
_CHECK_EVERY_SECONDS = 3600
_REQUEST_TIMEOUT = 15.0
_DOWNLOAD_TIMEOUT = 120.0
_MAX_ASSET_BYTES = 200 * 1024 * 1024  # a built frontend + app source, generously bounded

# Paths replaced by an applied update — an allow-list, not a deny-list, so
# nothing outside it (config.yaml, the db + -wal/-shm, venv, logs, backups)
# is ever touched no matter what a release tarball happens to contain.
_UPDATED_PATHS = ("app", "migrations", "docs", "VERSION", "requirements.txt")


def _version_file() -> Path:
    return Path(__file__).resolve().parent.parent / "VERSION"


def current_version() -> tuple[int, int, int]:
    try:
        parts = _version_file().read_text().strip().split(".")
        if len(parts) >= 3:
            return int(parts[0]), int(parts[1]), int(parts[2])
    except (OSError, ValueError):
        pass
    return (0, 0, 0)


def _parse_tag(tag: str) -> Optional[tuple[int, int, int]]:
    core = tag.lstrip("vV").split(".")
    if len(core) < 3:
        return None
    try:
        return int(core[0]), int(core[1]), int(core[2])
    except ValueError:
        return None


async def _get_setting(db: aiosqlite.Connection, key: str, default=None):
    async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return default


async def _set_setting(db: aiosqlite.Connection, key: str, value: Any) -> None:
    await db.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, json.dumps(value)),
    )
    await db.commit()


async def status(db: aiosqlite.Connection) -> dict:
    major, minor, patch = current_version()
    return {
        "current_version": _version_file().read_text().strip() if _version_file().exists() else f"{major}.{minor}.{patch}",
        "latest_tag": await _get_setting(db, "self_update_latest_tag"),
        "latest_url": await _get_setting(db, "self_update_latest_url"),
        "update_available": await _get_setting(db, "self_update_available", False),
        "checked_at": await _get_setting(db, "self_update_checked_at"),
        "last_error": await _get_setting(db, "self_update_last_error", ""),
        # Docker can't self-apply (see _refuses_auto_apply); the UI says so
        # up front instead of offering a button that would refuse.
        "docker": bool(os.environ.get("CORTEXARR_DOCKER")),
        "last_applied_tag": await _get_setting(db, "self_update_applied_tag"),
        "last_applied_at": await _get_setting(db, "self_update_applied_at"),
    }


async def check_latest(db: aiosqlite.Connection) -> dict:
    """Read-only: ask GitHub for the latest release, record what's found.
    Safe to call from any mode, any number of times."""
    error = ""
    release: Optional[dict] = None
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
            resp = await client.get(_RELEASES_URL, headers={"Accept": "application/vnd.github+json"})
        if resp.status_code == 404:
            error = "No releases published yet"
        else:
            resp.raise_for_status()
            release = resp.json()
    except httpx.HTTPError as exc:
        error = f"Couldn't reach GitHub: {exc}"

    available = False
    if release:
        tag = release.get("tag_name", "")
        parsed = _parse_tag(tag)
        if parsed and parsed > current_version():
            available = True
        await _set_setting(db, "self_update_latest_tag", tag)
        await _set_setting(db, "self_update_latest_url", release.get("html_url", ""))
        await _set_setting(db, "self_update_latest_assets", release.get("assets", []))

    await _set_setting(db, "self_update_available", available)
    await _set_setting(db, "self_update_checked_at", dt.datetime.now(dt.timezone.utc).isoformat())
    await _set_setting(db, "self_update_last_error", error)
    await db.commit()
    return await status(db)


def _in_window(now: dt.time, start: str, end: str) -> bool:
    try:
        h1, m1 = (int(x) for x in start.split(":"))
        h2, m2 = (int(x) for x in end.split(":"))
    except ValueError:
        return False
    lo, hi = dt.time(h1, m1), dt.time(h2, m2)
    if lo <= hi:
        return lo <= now <= hi
    return now >= lo or now <= hi  # window wraps past midnight


def _is_git_checkout(install_dir: Path) -> bool:
    return (install_dir / ".git").exists()


def _refuses_auto_apply(install_dir: Path) -> str:
    """Reasons an install can never safely self-mutate — checked before
    every apply, not just once at startup, since the setting can change
    without a restart."""
    if os.environ.get("CORTEXARR_DOCKER"):
        return (
            "running in the Docker image — app/, migrations/ and the built frontend "
            "live in the read-only image layer, not a writable install directory a "
            "file swap could persist. Pull a new image tag instead."
        )
    if _is_git_checkout(install_dir):
        return f"{install_dir} looks like a git checkout — refusing to overwrite it"
    return ""


def _find_asset_url(assets: list[dict]) -> Optional[str]:
    for asset in assets:
        name = asset.get("name", "")
        if name.startswith("cortexarr-") and name.endswith(".tar.gz"):
            return asset.get("browser_download_url")
    return None


async def apply_update(db: aiosqlite.Connection) -> dict:
    """Download the latest release's packaged asset and apply it in place.
    Only ever called from auto mode, inside the configured window — see
    maybe_apply(). Raises on anything that isn't a clean, verified apply;
    never partially overwrites install_dir."""
    install_dir = Path(get_settings().install_dir)
    refusal = _refuses_auto_apply(install_dir)
    if refusal:
        raise RuntimeError(f"Refusing to auto-apply: {refusal}")

    assets = await _get_setting(db, "self_update_latest_assets", [])
    tag = await _get_setting(db, "self_update_latest_tag", "")
    asset_url = _find_asset_url(assets)
    if not asset_url:
        raise RuntimeError(f"Release {tag or '(unknown)'} has no cortexarr-*.tar.gz asset")

    with tempfile.TemporaryDirectory(prefix="cortexarr-update-") as tmp:
        tmp_path = Path(tmp)
        archive = tmp_path / "release.tar.gz"
        downloaded = 0
        async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
            async with client.stream("GET", asset_url) as resp:
                resp.raise_for_status()
                with archive.open("wb") as f:
                    async for chunk in resp.aiter_bytes():
                        downloaded += len(chunk)
                        if downloaded > _MAX_ASSET_BYTES:
                            raise RuntimeError("Release asset exceeded the size limit — aborting download")
                        f.write(chunk)

        extract_dir = tmp_path / "extracted"
        extract_dir.mkdir()
        with tarfile.open(archive) as tf:
            _safe_extract(tf, extract_dir)

        staged = _find_staged_root(extract_dir)
        _verify_staged(staged)

        for name in _UPDATED_PATHS:
            src = staged / name
            if not src.exists():
                continue
            dest = install_dir / name
            if dest.exists():
                if dest.is_dir():
                    shutil.rmtree(dest)
                else:
                    dest.unlink()
            if src.is_dir():
                shutil.copytree(src, dest)
            else:
                shutil.copy2(src, dest)

        frontend_dist_src = staged / "frontend" / "dist"
        if frontend_dist_src.exists():
            frontend_dist_dest = install_dir / "frontend" / "dist"
            if frontend_dist_dest.exists():
                shutil.rmtree(frontend_dist_dest)
            frontend_dist_dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(frontend_dist_src, frontend_dist_dest)

        pip = install_dir / "venv" / "bin" / "pip"
        if pip.exists():
            subprocess.run(
                [str(pip), "install", "--quiet", "-r", str(install_dir / "requirements.txt")],
                check=True, timeout=300,
            )

    await _set_setting(db, "self_update_applied_tag", tag)
    await _set_setting(db, "self_update_applied_at", dt.datetime.now(dt.timezone.utc).isoformat())
    await _set_setting(db, "self_update_available", False)
    await db.commit()
    log.info("Self-update applied: %s", tag)
    return {"applied": tag}


def _safe_extract(tf: tarfile.TarFile, dest: Path) -> None:
    dest_resolved = dest.resolve()
    for member in tf.getmembers():
        target = (dest / member.name).resolve()
        if target != dest_resolved and dest_resolved not in target.parents:
            raise RuntimeError(f"Release archive has an unsafe path: {member.name}")
    tf.extractall(dest)


def _find_staged_root(extract_dir: Path) -> Path:
    entries = list(extract_dir.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return extract_dir


def _verify_staged(staged: Path) -> None:
    required = ["app/main.py", "VERSION", "requirements.txt", "frontend/dist/index.html"]
    missing = [p for p in required if not (staged / p).exists()]
    if missing:
        raise RuntimeError(f"Release package is missing expected files: {missing}")


class UpdateRefused(Exception):
    """An update that can't or shouldn't be applied right now — already up
    to date, GitHub unreachable, or an install that must not self-mutate
    (a git checkout, the Docker image). Not a failure: nothing was touched."""


async def apply_now(db: aiosqlite.Connection) -> dict:
    """The admin's "Update now" click: the same download-and-swap auto mode
    does, but on demand and outside the daily window — the person pressing
    the button is the window. Re-checks GitHub first so a stale "available"
    flag can't apply an old release. The caller is responsible for exiting
    afterwards so systemd brings the new code up (see maybe_apply)."""
    found = await check_latest(db)
    if not found["update_available"]:
        raise UpdateRefused(found["last_error"] or "Already up to date")
    refusal = _refuses_auto_apply(Path(get_settings().install_dir))
    if refusal:
        raise UpdateRefused(refusal[0].upper() + refusal[1:])
    return await apply_update(db)


async def maybe_apply(db: aiosqlite.Connection) -> None:
    mode = await _get_setting(db, "self_update_mode", "manual")
    if mode != "auto":
        return
    if not await _get_setting(db, "self_update_available", False):
        return
    start = await _get_setting(db, "self_update_window_start", "02:00")
    end = await _get_setting(db, "self_update_window_end", "04:00")
    if not _in_window(dt.datetime.now().time(), start, end):
        return
    try:
        await apply_update(db)
    except Exception as exc:
        log.exception("Self-update apply failed")
        await _set_setting(db, "self_update_last_error", f"Apply failed: {exc}")
        await db.commit()
        return
    # A file swap just happened under the running process's own feet —
    # exit now rather than keep serving from a half-replaced app/ tree.
    # os._exit (not sys.exit — a Task catches that, it wouldn't stop the
    # process) so systemd (Restart=always) sees the process end and brings
    # the new code back up.
    log.info("Self-update applied — exiting for systemd to restart")
    os._exit(0)


async def run_forever() -> None:
    log.info("Self-update checker started (every %ss)", _CHECK_EVERY_SECONDS)
    while True:
        try:
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                await check_latest(db)
                await maybe_apply(db)
        except Exception:
            log.exception("Self-update check failed")
        await asyncio.sleep(_CHECK_EVERY_SECONDS)
