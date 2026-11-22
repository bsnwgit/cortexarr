"""
Duplicate-file scan for a Sonarr or Radarr service — reads everything from the
service's own connection, no SSH and no mount.

For every series / movie the service has, its own file browser
(/api/v3/filesystem, the one behind its folder picker) is walked from that
folder down, so what is really on disk is what is checked — a stray second
file that Sonarr/Radarr never indexed still shows up. The paths are the service's own (inside its container, if it runs in one), so
nothing has to be mapped. Which rule applies follows the service: Radarr's
folders are movies, Sonarr's are series.

What counts as a duplicate (agreed with the owner, not a guess):
  - Movies: a movie folder holding more than one video file. A movie that aired as a series
    (The.Stand.2020-S01E05) has one file per episode: different S##E## codes are not
    duplicates, the same code in two files is.
  - Series: the same S##E## code in the name of more than one file under a
    series folder — season folders don't matter, only the code. A file with
    no S##E## in its name is flagged too; it is counted as a problem exactly
    like a duplicate, but it is not known to be a copy of anything, so
    Cortexarr never offers to delete it.

Left out, so they don't read as duplicates: files in extras-type folders
(Extras, Featurettes, Trailers, ...) and anything named like a sample or a
trailer. Only video files count — subtitles, .nfo and artwork are ignored.

Left out as one thing in pieces, not copies: a disc rip's numbered files (00052.m2ts, anything in
BDMV/VIDEO_TS) and files split by a part marker (cd1/cd2, part1/part2, disc1/disc2).

The service's `duplicate_scan` setting is JSON: enabled, interval_minutes and
show_hidden_cleanup (whether the Duplicates page offers the "._" file cleanup command).
Every Sonarr/Radarr scans by default — a service with nothing saved is on, and
only an explicit `enabled: false` turns it off.

Delete goes through the service (DELETE /episodefile/{id} or /moviefile/{id}),
so it can only remove a file the service has indexed; a stray file it has never
seen has to be removed where it lives.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from app.services import arr_http
from app.services.errors import ConnectivityError, ServiceApiError

__all__ = [
    "ConnectivityError", "ServiceApiError", "KINDS",
    "parse_config", "scan", "delete_file", "delete_files", "find_duplicates", "episode_codes", "pick_keep",
]

# Which rule a service type's folders follow, and how the service names things.
KINDS = {"sonarr": "series", "radarr": "movie"}
_APPS = {"sonarr": ("Sonarr", "/api/v3/series", "/api/v3/episodefile", "seriesId"),
         "radarr": ("Radarr", "/api/v3/movie", "/api/v3/moviefile", "movieId")}
_MAX_DIRS = 5000          # per series / movie — a runaway folder tree is cut off, not followed forever

VIDEO_EXTENSIONS = {
    ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".flv", ".webm", ".iso",
}
# Folders whose videos are bonus material, not the movie or the episode.
_EXTRA_DIRS = {
    "extras", "extra", "featurettes", "trailers", "behind the scenes", "deleted scenes", "interviews",
    "scenes", "shorts", "other", "sample", "samples",
}
# A disc rip's own folders (Blu-ray BDMV/STREAM, DVD VIDEO_TS): one movie in many numbered pieces.
_DISC_DIRS = {"bdmv", "stream", "clipinf", "playlist", "backup", "auxdata", "video_ts", "audio_ts", "hvdvd_ts"}
# A piece of a disc rip by name alone: 00052.m2ts, VTS_01_1.vob.
_PIECE_NAME = re.compile(r"^(\d+|vts_\d+_\d+)$", re.IGNORECASE)
# "Movie cd1.avi", "Movie - part2.mkv", "Movie.disc1.mkv": a marker at the end of the name.
_PART_MARK = re.compile(r"[\s._-]+(cd|dvd|disc|disk|part|pt)[\s._-]?\d+$", re.IGNORECASE)
_SAMPLE_NAME = re.compile(r"(^|[^a-z])(sample|trailer)([^a-z]|$)", re.IGNORECASE)
# S03E02, and the multi-episode forms S03E02E03 / S03E02-E03.
_EPISODE = re.compile(r"[Ss](\d{1,3})[Ee](\d{1,3})((?:[-_ ]?[Ee]\d{1,3})*)")

DEFAULT_INTERVAL_MINUTES = 360
_CONCURRENCY = 4          # folders listed at once — each is a read of the disk behind the service
_LIST_TIMEOUT = 120.0     # a folder listing on a busy NAS can be slow


@dataclass
class Finding:
    key: str
    kind: str            # 'movie' | 'series'
    title: str
    reason: str
    files: list[str] = field(default_factory=list)
    folder: str = ""                                   # the series / movie folder the files are in
    info: dict[str, dict[str, Any]] = field(default_factory=dict)   # path -> {"size": bytes, "modified": ISO date}

    @property
    def deletable(self) -> bool:
        """A real duplicate has at least two files; a no-code file is alone."""
        return len(self.files) >= 2


@dataclass
class ScanResult:
    files_seen: int
    seconds: float
    findings: list[Finding]
    problems: list[str] = field(default_factory=list)   # folders that couldn't be read
    # macOS "._name" metadata files seen (never counted as duplicates): {"count", "roots": {folder: n}, "samples": [...]}
    junk: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def parse_config(raw: str | dict | None) -> dict[str, Any]:
    """Validate a service's duplicate-scan settings. Raises ValueError with a
    plain message. Settings saved by older versions (a login, key and folder list)
    are ignored."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("The duplicate-scan settings are not valid JSON") from exc
    raw = raw or {}
    try:
        interval = int(raw.get("interval_minutes") or DEFAULT_INTERVAL_MINUTES)
    except (TypeError, ValueError):
        raise ValueError("The scan interval must be a number") from None
    enabled = bool(raw.get("enabled", True))
    if enabled and interval < 10:
        raise ValueError("Scan at most every 10 minutes")
    # Off unless the admin asks: the Duplicates page then shows a section for macOS "._" files
    # with a command that deletes them.
    return {"enabled": enabled, "interval_minutes": interval,
            "show_hidden_cleanup": bool(raw.get("show_hidden_cleanup", False))}


def _is_video(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in VIDEO_EXTENSIONS


def _counts(rel: PurePosixPath) -> bool:
    """A video that is the movie / the episode itself, not bonus material.
    `rel` is relative to the library folder; parts[0] is the movie or series
    folder itself, so a show called "Other" is not an extras folder."""
    # A leading dot is a hidden file — notably the "._name.mkv" metadata copies macOS leaves
    # next to every real file on a network share. They are not the movie or the episode.
    if rel.name.startswith(".") or not _is_video(rel.name) or _SAMPLE_NAME.search(rel.stem):
        return False
    # A numbered disc piece is part of one movie, never a second copy of it.
    if _PIECE_NAME.match(rel.stem) or any(part.lower() in _DISC_DIRS for part in rel.parts[1:-1]):
        return False
    return not any(part.lower() in _EXTRA_DIRS for part in rel.parts[1:-1])


def _drop_sequences(paths: list[str]) -> list[str]:
    """Files split into parts — "Movie cd1.avi" and "Movie cd2.avi" — are one movie
    in pieces, not copies. Only a real sequence goes: two or more files in one
    folder that differ just by the part number. A lone "Part 2" title stays."""
    groups: dict[tuple[str, str], list[str]] = {}
    for p in paths:
        pp = PurePosixPath(p)
        if _PART_MARK.search(pp.stem):
            groups.setdefault((str(pp.parent), _PART_MARK.sub("", pp.stem).lower()), []).append(p)
    pieces = {p for g in groups.values() if len(g) >= 2 for p in g}
    return [p for p in paths if p not in pieces]


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
        folders = {name: _drop_sequences(paths) for name, paths in folders.items()}

        if kind == "movie":
            for folder, paths in sorted(folders.items()):
                # A movie that aired as a series (The.Stand.2020-S01E05) is one file per episode:
                # different S##E## codes are different parts, the same code twice is a duplicate.
                by_code: dict[str, list[str]] = {}
                plain: list[str] = []
                for path in sorted(paths):
                    codes = episode_codes(PurePosixPath(path).name)
                    if not codes:
                        plain.append(path)
                    for code in codes:
                        by_code.setdefault(code, []).append(path)
                if len(plain) > 1:
                    out.append(Finding(f"movie:{root}/{folder}", "movie", folder,
                                       f"{len(plain)} video files in the movie folder", plain,
                                       folder=f"{root}/{folder}"))
                for code, dupes in sorted(by_code.items()):
                    if len(dupes) > 1:
                        out.append(Finding(f"movie:{root}/{folder}:{code}", "movie", f"{folder} — {code}",
                                           f"{len(dupes)} files for {code}", dupes, folder=f"{root}/{folder}"))
            continue

        for show, paths in sorted(folders.items()):
            by_code: dict[str, list[str]] = {}
            for path in sorted(paths):
                name = PurePosixPath(path).name
                codes = episode_codes(name)
                if not codes:
                    out.append(Finding(f"series:{root}/{show}:nocode:{name}", "series", f"{show} — {name}",
                                       "no S##E## episode code in the file name", [path],
                                       folder=f"{root}/{show}"))
                for code in codes:
                    by_code.setdefault(code, []).append(path)
            for code, dupes in sorted(by_code.items()):
                if len(dupes) > 1:
                    out.append(Finding(f"series:{root}/{show}:{code}", "series", f"{show} — {code}",
                                       f"{len(dupes)} files for {code}", dupes, folder=f"{root}/{show}"))
    return out


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

async def scan(service_type: str, config: str | dict, base_url: str, api_key: str) -> ScanResult:
    """Ask the service for every series / movie, then for the files of each.
    A series / movie folder that can't be read is reported in `problems` and skipped — the
    others still count — except when none could be, which is an error."""
    kind = KINDS.get(service_type)
    if not kind:
        raise ServiceApiError(f"'{service_type}' has no files to scan")
    if not parse_config(config)["enabled"]:
        raise ServiceApiError("The duplicate scan is turned off for this service")
    app, items_path, files_path, id_param = _APPS[service_type]
    started = time.monotonic()

    items = await arr_http.get(app, base_url, api_key, items_path, timeout=60.0)
    items = [i for i in (items if isinstance(items, list) else []) if i.get("path") and i.get("id") is not None]
    gate = asyncio.Semaphore(_CONCURRENCY)
    problems: list[str] = []

    async def one(item: dict) -> tuple[str, dict[str, dict[str, Any]]]:
        folder = str(item["path"]).rstrip("/")
        found: dict[str, dict[str, Any]] = {}
        pending, seen = [folder], 0
        async with gate:
            while pending and seen < _MAX_DIRS:
                here = pending.pop()
                seen += 1
                listing = await arr_http.get(
                    app, base_url, api_key, "/api/v3/filesystem",
                    {"path": here, "includeFiles": "true", "allowFoldersWithoutTrailingSlashes": "true"},
                    timeout=_LIST_TIMEOUT)
                if not isinstance(listing, dict):
                    continue
                # A folder that doesn't exist is answered with its parent's (or the root's) listing —
                # taking that would walk the whole library once per missing folder. Only what is
                # inside the folder asked about counts.
                inside = here.rstrip("/") + "/"
                for f in listing.get("files") or []:
                    if f.get("path") and f["path"].startswith(inside):
                        found[f["path"]] = {"size": f.get("size"), "modified": f.get("lastModified")}
                pending.extend(d["path"] for d in listing.get("directories") or []
                               if d.get("path") and d["path"].startswith(inside))
        return folder, found

    results = await asyncio.gather(*(one(i) for i in items), return_exceptions=True)
    listed: dict[str, list[str]] = {}
    meta: dict[str, dict[str, Any]] = {}
    for item, res in zip(items, results):
        if isinstance(res, BaseException):
            if isinstance(res, (ConnectivityError, ServiceApiError)):
                problems.append(f"{item.get('title') or item['path']}: {res}")
                continue
            raise res
        folder, files = res
        root = str(PurePosixPath(folder).parent)
        listed.setdefault(root, []).extend(sorted(p for p in files if p.startswith(folder + "/")))
        meta.update(files)
    if items and not listed:
        raise ServiceApiError("; ".join(problems[:3]) or "Nothing could be read")
    if len(problems) > 5:
        problems = problems[:5] + [f"and {len(problems) - 5} more"]
    findings = find_duplicates(kind, listed)
    for f in findings:
        f.info = {p: meta[p] for p in f.files if p in meta}
    return ScanResult(
        files_seen=sum(len(v) for v in listed.values()),
        seconds=round(time.monotonic() - started, 1),
        findings=findings, problems=problems, junk=_hidden_files(listed),
    )


def _hidden_files(files_by_root: dict[str, list[str]]) -> dict[str, Any]:
    """The "._name" files among what was listed: how many, per library folder, and a few examples."""
    roots: dict[str, int] = {}
    samples: list[str] = []
    for root, files in files_by_root.items():
        n = [p for p in files if PurePosixPath(p).name.startswith("._")]
        if n:
            roots[root] = len(n)
            samples.extend(n[: max(0, 20 - len(samples))])
    return {"count": sum(roots.values()), "roots": roots, "samples": samples} if roots else {}


def pick_keep(files: list[str], info: dict[str, dict[str, Any]]) -> str | None:
    """Which copy to keep: the newest, because a file is usually downloaded
    again for a reason (a better release, a repair). An empty file is never
    the one kept, however new. None when any file's size or date is unknown, or
    all of them are empty — nothing is then decided for the owner, and that
    group is left alone by "delete all"."""
    if len(files) < 2:
        return None
    for p in files:
        meta = info.get(p) or {}
        if not isinstance(meta.get("size"), int) or not meta.get("modified"):
            return None
    candidates = [p for p in files if info[p]["size"] > 0]
    if not candidates:
        return None
    return max(candidates, key=lambda p: (info[p]["modified"], info[p]["size"], p))


async def delete_files(
    service_type: str, base_url: str, api_key: str, paths: list[str],
) -> tuple[list[str], dict[str, str]]:
    """Delete several files through the service, reading its series/movie list
    once. Returns (deleted, {path: why it wasn't}). A file the service has never
    indexed is skipped, not fatal; an unreachable service raises ConnectivityError."""
    app, items_path, files_path, id_param = _APPS[service_type]
    items = await arr_http.get(app, base_url, api_key, items_path, timeout=60.0)
    indexed_by_owner: dict[Any, list[dict]] = {}
    deleted: list[str] = []
    failed: dict[str, str] = {}
    for path in paths:
        owner = next((i for i in items if i.get("path") and path.startswith(str(i["path"]).rstrip("/") + "/")), None)
        if not owner:
            failed[path] = f"{app} has never indexed this file"
            continue
        if owner["id"] not in indexed_by_owner:
            indexed_by_owner[owner["id"]] = await arr_http.get(app, base_url, api_key, files_path, {id_param: owner["id"]})
        match = next((f for f in indexed_by_owner[owner["id"]] if f.get("path") == path), None)
        if not match:
            failed[path] = f"{app} has never indexed this file"
            continue
        try:
            await arr_http.delete(app, base_url, api_key, f"{files_path}/{match['id']}")
            deleted.append(path)
        except ServiceApiError as exc:
            failed[path] = str(exc)
    return deleted, failed


async def delete_file(service_type: str, base_url: str, api_key: str, path: str) -> None:
    """Delete one file through the service. The caller has already checked it
    is a file the last scan reported. Only a file the service has indexed can
    be removed this way."""
    app, items_path, files_path, id_param = _APPS[service_type]
    items = await arr_http.get(app, base_url, api_key, items_path, timeout=60.0)
    owner = next((i for i in items if i.get("path") and path.startswith(str(i["path"]).rstrip("/") + "/")), None)
    if owner:
        indexed = await arr_http.get(app, base_url, api_key, files_path, {id_param: owner["id"]})
        match = next((f for f in indexed if f.get("path") == path), None)
        if match:
            await arr_http.delete(app, base_url, api_key, f"{files_path}/{match['id']}")
            return
    raise ServiceApiError(f"{app} has never indexed this file, so it can't delete it — remove it where the file is stored")
