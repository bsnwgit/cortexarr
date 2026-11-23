"""
Delete files and folders straight from a movie's library folder — the things
Radarr itself can't remove because it never indexed them (an extra copy,
sample, sub-folder or stray download).

Radarr only deletes the one file it tracks, and Cortexarr has no access to the
disk unless an admin gives it some. Two ways, chosen per service in
Settings → Services (stored in the service's `duplicate_scan` JSON as
`file_access`):

  - mount: the library is mounted into the host Cortexarr runs on; a path
    mapping turns Radarr's path (inside its own container) into the mount's.
  - ssh:   the `ssh` program runs `rm` on the machine that holds the files,
    with a key file that lives on the Cortexarr host — the key itself is never
    stored in the database. The host key must be saved with the settings and
    is checked on every connection.

Safety, for both: the caller only passes a path that Radarr's own folder
listing reported under the movie's folder; here it must also be relative, free
of `..`, and strictly inside the mapped library folder. A mount is confined to
its real path, so a symlink can't lead out of it.
"""
from __future__ import annotations

import asyncio
import os
import re
import shlex
import shutil
import tempfile
from pathlib import PurePosixPath
from typing import Any

__all__ = ["LibraryFilesError", "parse_access", "map_path", "delete_entry", "METHODS"]

METHODS = ("none", "mount", "ssh")
_USER = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]*$")
_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_-]*$")
_SSH_TIMEOUT = 60.0


class LibraryFilesError(Exception):
    """A plain, user-facing reason a delete wasn't done."""


def _abs_dir(value: Any, label: str) -> str:
    text = str(value or "").strip().rstrip("/")
    parts = text.split("/")
    if not text.startswith("/") or ".." in parts or "\n" in text or "\0" in text:
        raise ValueError(f"{label} must be an absolute path, e.g. /movies")
    return text


def parse_access(raw: dict | None) -> dict[str, Any]:
    """Validate a service's file-access settings. Raises ValueError with a plain message."""
    raw = raw or {}
    method = str(raw.get("method") or "none")
    if method not in METHODS:
        raise ValueError("File access must be none, mount or ssh")
    if method == "none":
        return {"method": "none"}
    out: dict[str, Any] = {
        "method": method,
        "service_path": _abs_dir(raw.get("service_path"), "The library folder as Radarr sees it"),
        "local_path": _abs_dir(raw.get("local_path"), "The library folder as Cortexarr reaches it"),
    }
    if method == "ssh":
        ssh = raw.get("ssh") or {}
        host, user = str(ssh.get("host") or "").strip(), str(ssh.get("user") or "").strip()
        if not _HOST.match(host):
            raise ValueError("Enter the host name or address to SSH to")
        if not _USER.match(user):
            raise ValueError("Enter the SSH user name")
        try:
            port = int(ssh.get("port") or 22)
        except (TypeError, ValueError):
            raise ValueError("The SSH port must be a number") from None
        if not 1 <= port <= 65535:
            raise ValueError("The SSH port must be between 1 and 65535")
        key_path = _abs_dir(ssh.get("key_path"), "The SSH key file")
        lines = [ln.strip() for ln in str(ssh.get("host_key") or "").splitlines() if ln.strip() and not ln.startswith("#")]
        if not lines or any(len(ln.split()) < 3 for ln in lines):
            raise ValueError("Paste the host key line (from ssh-keyscan) so the server can be verified")
        out["ssh"] = {"host": host, "port": port, "user": user, "key_path": key_path, "host_key": "\n".join(lines)}
    return out


def map_path(movie_service_path: str, access: dict[str, Any]) -> str:
    """The movie folder as the delete method reaches it. Raises LibraryFilesError."""
    movie = movie_service_path.rstrip("/")
    base = access["service_path"]
    if not movie.startswith(base + "/"):
        raise LibraryFilesError(
            f"This movie's folder ({movie}) isn't inside the library folder set in Settings ({base})")
    return access["local_path"] + movie[len(base):]


def _relative(rel: str) -> PurePosixPath:
    parts = rel.split("/")
    if (not rel or rel.startswith("/") or any(p in ("", ".", "..") for p in parts)
            or "\0" in rel or "\n" in rel):
        raise LibraryFilesError("That isn't a valid path inside the movie folder")
    return PurePosixPath(rel)


def _delete_mounted(root: str, rel: PurePosixPath) -> None:
    base = os.path.realpath(root)
    if not os.path.isdir(base):
        raise LibraryFilesError("The movie's folder isn't reachable from Cortexarr — is the library mounted?")
    target = os.path.join(root, *rel.parts)
    parent = os.path.realpath(os.path.dirname(target))
    if parent != base and not parent.startswith(base + os.sep):
        raise LibraryFilesError("That path leads outside the movie folder, so it was not deleted")
    if os.path.islink(target) or os.path.isfile(target):
        os.unlink(target)
    elif os.path.isdir(target):
        shutil.rmtree(target)
    else:
        raise LibraryFilesError("That file or folder is already gone")


async def _delete_ssh(root: str, rel: PurePosixPath, ssh: dict[str, Any]) -> None:
    target = f"{root}/{rel}"
    with tempfile.TemporaryDirectory() as tmp:
        known = os.path.join(tmp, "known_hosts")
        with open(known, "w") as fh:
            fh.write(ssh["host_key"] + "\n")
        cmd = [
            "ssh", "-p", str(ssh["port"]), "-i", ssh["key_path"],
            "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={known}", "-o", "ConnectTimeout=15",
            f"{ssh['user']}@{ssh['host']}",
            f"test -e {shlex.quote(target)} || exit 3; rm -rf -- {shlex.quote(target)}",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError:
            raise LibraryFilesError("The ssh program isn't installed where Cortexarr runs") from None
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=_SSH_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise LibraryFilesError("The SSH connection timed out") from None
    if proc.returncode == 3:
        raise LibraryFilesError("That file or folder is already gone")
    if proc.returncode != 0:
        detail = err.decode(errors="replace").strip().splitlines()
        raise LibraryFilesError("SSH failed: " + (detail[-1] if detail else f"exit {proc.returncode}"))


async def delete_entry(access: dict[str, Any], movie_service_path: str, rel: str) -> None:
    """Delete one file or folder (everything inside it) under a movie's folder."""
    if access.get("method") not in ("mount", "ssh"):
        raise LibraryFilesError("File access isn't set up for this service")
    path = _relative(rel)
    root = map_path(movie_service_path, access)
    if access["method"] == "mount":
        await asyncio.to_thread(_delete_mounted, root, path)
    else:
        await _delete_ssh(root, path, access["ssh"])
