"""
Duplicate-file scan for a Sonarr or Radarr service — finds the real files on
the machine that holds them, over SSH with the system `ssh` binary (no library,
no mount).

There is no API to ask: Sonarr, Radarr and Plex only know the files they have
indexed, so a stray second file can slip past all of them. Listing the real
folders is the one way to be sure, so this runs `find` on the machine and works
out the duplicates itself. Which rule applies follows the service: a Radarr
service's folders are movies, a Sonarr service's are series.

What counts as a duplicate (agreed with the owner, not a guess):
  - Movies: a movie folder (a direct child of a folder you list) holding more
    than one video file.
  - Series: the same S##E## code in the name of more than one file under a
    series folder — season folders don't matter, only the code. A file with
    no S##E## in its name is flagged too; it is counted as a problem exactly
    like a duplicate, but it is not known to be a copy of anything, so
    Cortexarr never offers to delete it.

Left out, so they don't read as duplicates: files in extras-type folders
(Extras, Featurettes, Trailers, ...) and anything named like a sample or a
trailer. Only video files count — subtitles, .nfo and artwork are ignored.

The service's `duplicate_scan` setting is JSON: enabled, ssh_host, ssh_user,
ssh_port, key_path (a path on THIS host — the key itself is never read), paths
(folders on the SSH machine) and interval_minutes.

Delete is `rm` over the same SSH login, and only ever for a path the last scan
reported inside a configured folder (app/api/duplicates.py enforces that).
"""
from __future__ import annotations

import asyncio
import json
import re
import shlex
import time
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from app.config import get_settings
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "KINDS",
    "parse_config", "test_connection", "scan", "delete_file", "find_duplicates", "episode_codes",
]

# Which rule a service type's folders follow.
KINDS = {"sonarr": "series", "radarr": "movie"}

VIDEO_EXTENSIONS = {
    ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".flv", ".webm", ".iso",
}
# Folders whose videos are bonus material, not the movie or the episode.
_EXTRA_DIRS = {
    "extras", "extra", "featurettes", "trailers", "behind the scenes", "deleted scenes", "interviews",
    "scenes", "shorts", "other", "sample", "samples",
}
_SAMPLE_NAME = re.compile(r"(^|[^a-z])(sample|trailer)([^a-z]|$)", re.IGNORECASE)
# S03E02, and the multi-episode forms S03E02E03 / S03E02-E03.
_EPISODE = re.compile(r"[Ss](\d{1,3})[Ee](\d{1,3})((?:[-_ ]?[Ee]\d{1,3})*)")
_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_USER = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")

DEFAULT_INTERVAL_MINUTES = 360
_SSH_TIMEOUT = 20.0       # connecting / a quick command
_SCAN_TIMEOUT = 1800.0    # listing one folder tree; a big library is slow over NFS
_MAX_FILES = 2_000_000    # stop reading a runaway listing rather than fill memory


@dataclass
class Finding:
    key: str
    kind: str            # 'movie' | 'series'
    title: str
    reason: str
    files: list[str] = field(default_factory=list)

    @property
    def deletable(self) -> bool:
        """A real duplicate has at least two files; a no-code file is alone."""
        return len(self.files) >= 2


@dataclass
class ScanResult:
    files_seen: int
    seconds: float
    findings: list[Finding]
    problems: list[str] = field(default_factory=list)   # folders that couldn't be listed


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def parse_config(raw: str | dict | None) -> dict[str, Any]:
    """Validate a service's duplicate-scan settings. Raises ValueError with a
    plain message. A scan that is off needs nothing else filled in."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("The duplicate-scan settings are not valid JSON") from exc
    raw = raw or {}
    enabled = bool(raw.get("enabled"))
    cfg: dict[str, Any] = {
        "enabled": enabled,
        "ssh_host": str(raw.get("ssh_host") or "").strip(),
        "ssh_user": str(raw.get("ssh_user") or "").strip(),
        "ssh_port": 22,
        "key_path": str(raw.get("key_path") or "").strip(),
        "paths": _paths(raw.get("paths")),
        "interval_minutes": DEFAULT_INTERVAL_MINUTES,
    }
    try:
        cfg["ssh_port"] = int(raw.get("ssh_port") or 22)
        cfg["interval_minutes"] = int(raw.get("interval_minutes") or DEFAULT_INTERVAL_MINUTES)
    except (TypeError, ValueError):
        raise ValueError("The SSH port and the scan interval must be numbers") from None
    if not enabled:
        return cfg
    if not _HOST.match(cfg["ssh_host"]):
        raise ValueError("Enter the host to log in to over SSH — a name or address, no spaces or leading dash")
    if not _USER.match(cfg["ssh_user"]):
        raise ValueError("Enter the SSH user")
    if not 1 <= cfg["ssh_port"] <= 65535:
        raise ValueError("The SSH port must be 1–65535")
    if not cfg["key_path"].startswith("/"):
        raise ValueError("Enter the full path of the SSH key file on the Cortexarr host")
    if not cfg["paths"]:
        raise ValueError("Add at least one folder to scan")
    if cfg["interval_minutes"] < 10:
        raise ValueError("Scan at most every 10 minutes")
    return cfg


def _paths(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.splitlines()
    out: list[str] = []
    for p in value:
        p = str(p).strip()
        if not p:
            continue
        if not p.startswith("/") or ".." in PurePosixPath(p).parts or "\x00" in p or "\n" in p:
            raise ValueError(f"The folder '{p}' must be a full path with no '..'")
        p = p.rstrip("/") or "/"
        if p == "/":
            raise ValueError("A folder can't be the root of the disk")
        if p not in out:
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------

def _ssh_args(cfg: dict[str, Any]) -> list[str]:
    known_hosts = f"{get_settings().install_dir}/known_hosts"
    return [
        "ssh",
        "-i", cfg["key_path"], "-p", str(cfg["ssh_port"]),
        "-o", "BatchMode=yes",                      # never stop to ask for a password
        "-o", "IdentitiesOnly=yes",                 # only this key, not whatever an agent offers
        "-o", "StrictHostKeyChecking=accept-new",   # trust on first use, then pin
        "-o", f"UserKnownHostsFile={known_hosts}",
        "-o", "ConnectTimeout=10",
        f"{cfg['ssh_user']}@{cfg['ssh_host']}",
    ]


async def _run(cfg: dict[str, Any], remote: str, timeout: float) -> tuple[int, bytes, str]:
    """Run one remote command. Returns (exit code, stdout, stderr text)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *_ssh_args(cfg), remote,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise ConnectivityError("The ssh program isn't installed on the Cortexarr host") from exc
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise ConnectivityError(f"Timed out after {int(timeout)}s") from None
    return proc.returncode or 0, out, err.decode("utf-8", "replace").strip()


def _login_error(code: int, err: str) -> ConnectivityError:
    # 255 is ssh's own failure (connect, auth, host key); anything else is the remote command's.
    return ConnectivityError(err.splitlines()[-1] if err else f"ssh exited with {code}")


# ---------------------------------------------------------------------------
# Duplicate rules — pure, so they can be tested without a machine
# ---------------------------------------------------------------------------

def _is_video(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in VIDEO_EXTENSIONS


def _counts(rel: PurePosixPath) -> bool:
    """A video that is the movie / the episode itself, not bonus material.
    `rel` is relative to the library folder; parts[0] is the movie or series
    folder itself, so a show called "Other" is not an extras folder."""
    if not _is_video(rel.name) or _SAMPLE_NAME.search(rel.stem):
        return False
    return not any(part.lower() in _EXTRA_DIRS for part in rel.parts[1:-1])


def episode_codes(name: str) -> list[str]:
    """['S03E02'] — or several for a double episode. [] when there is none."""
    m = _EPISODE.search(name)
    if not m:
        return []
    season = int(m.group(1))
    episodes = [int(m.group(2))] + [int(n) for n in re.findall(r"[Ee](\d{1,3})", m.group(3) or "")]
    return [f"S{season:02d}E{e:02d}" for e in episodes]


def find_duplicates(kind: str, files_by_root: dict[str, list[str]]) -> list[Finding]:
    """kind: 'movie' or 'series'. files_by_root: folder -> every file path under it."""
    out: list[Finding] = []
    for root, files in files_by_root.items():
        folders: dict[str, list[str]] = {}
        for path in files:
            rel = PurePosixPath(path).relative_to(root)
            if len(rel.parts) < 2 or not _counts(rel):    # a loose file in the root has no folder to be duplicated in
                continue
            folders.setdefault(rel.parts[0], []).append(path)

        if kind == "movie":
            for folder, paths in sorted(folders.items()):
                if len(paths) > 1:
                    out.append(Finding(f"movie:{root}/{folder}", "movie", folder,
                                       f"{len(paths)} video files in the movie folder", sorted(paths)))
            continue

        for show, paths in sorted(folders.items()):
            by_code: dict[str, list[str]] = {}
            for path in sorted(paths):
                name = PurePosixPath(path).name
                codes = episode_codes(name)
                if not codes:
                    out.append(Finding(f"series:{root}/{show}:nocode:{name}", "series", f"{show} — {name}",
                                       "no S##E## episode code in the file name", [path]))
                for code in codes:
                    by_code.setdefault(code, []).append(path)
            for code, dupes in sorted(by_code.items()):
                if len(dupes) > 1:
                    out.append(Finding(f"series:{root}/{show}:{code}", "series", f"{show} — {code}",
                                       f"{len(dupes)} files for {code}", dupes))
    return out


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

async def _list(cfg: dict[str, Any], root: str) -> list[str]:
    code, out, err = await _run(cfg, f"find {shlex.quote(root)} -type f", _SCAN_TIMEOUT)
    if code == 255:
        raise _login_error(code, err)
    paths = [line for line in out.decode("utf-8", "replace").splitlines() if line.startswith(root + "/")]
    if code != 0 and not paths:
        raise ServiceApiError(err.splitlines()[-1] if err else f"find exited with {code}")
    return paths[:_MAX_FILES]


async def scan(service_type: str, config: str | dict) -> ScanResult:
    """List every configured folder and work out the duplicates. A folder that
    can't be listed is reported in `problems` and skipped — the others still
    count — except when none could be, which is an error. A login that fails
    raises ConnectivityError."""
    kind = KINDS.get(service_type)
    if not kind:
        raise ServiceApiError(f"'{service_type}' has no files to scan")
    cfg = parse_config(config)
    if not cfg["enabled"]:
        raise ServiceApiError("The duplicate scan is turned off for this service")
    started = time.monotonic()
    listed: dict[str, list[str]] = {}
    problems: list[str] = []
    for root in cfg["paths"]:
        try:
            listed[root] = await _list(cfg, root)
        except ServiceApiError as exc:
            problems.append(f"{root}: {exc}")
    if not listed:
        raise ServiceApiError("; ".join(problems) or "Nothing to scan")
    return ScanResult(
        files_seen=sum(len(v) for v in listed.values()),
        seconds=round(time.monotonic() - started, 1),
        findings=find_duplicates(kind, listed), problems=problems,
    )


async def test_connection(config: str | dict) -> tuple[bool, str]:
    """Log in and check each folder exists — without listing it."""
    try:
        cfg = parse_config({**(json.loads(config) if isinstance(config, str) else config), "enabled": True})
    except (ValueError, json.JSONDecodeError) as exc:
        return False, str(exc)
    checks = " ; ".join(f"[ -d {shlex.quote(p)} ] || echo MISSING {shlex.quote(p)}" for p in cfg["paths"])
    try:
        code, out, err = await _run(cfg, f"true ; {checks}", _SSH_TIMEOUT)
    except ConnectivityError as exc:
        return False, f"Could not connect: {exc}"
    if code == 255:
        return False, f"Could not connect: {_login_error(code, err)}"
    missing = [line.removeprefix("MISSING ") for line in out.decode("utf-8", "replace").splitlines()
               if line.startswith("MISSING ")]
    if missing:
        return False, "Connected, but these folders don't exist: " + ", ".join(missing)
    return True, f"Connected — {len(cfg['paths'])} folder(s) found"


async def delete_file(config: str | dict, path: str) -> None:
    """Delete one file. The caller has already checked it is a file the last
    scan reported; this only refuses what could never be one."""
    cfg = parse_config(config)
    if not any(path.startswith(root + "/") for root in cfg["paths"]):
        raise ServiceApiError("That file is not inside a configured folder")
    if ".." in PurePosixPath(path).parts or "\n" in path:
        raise ServiceApiError("Refusing that path")
    code, _, err = await _run(cfg, f"rm -f -- {shlex.quote(path)}", _SSH_TIMEOUT)
    if code == 255:
        raise _login_error(code, err)
    if code != 0:
        raise ServiceApiError(err.splitlines()[-1] if err else f"rm exited with {code}")
