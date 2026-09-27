"""
What to do about a current problem — a plain explanation of the likely cause,
read from the message the service gave, and the fixes Cortexarr can apply
from the Alerts page (app/api/alerts.py's /fix runs them).

Explanations are matched on the wording Sonarr/Radarr/NZBGet/SABnzbd/Seerr
actually use; anything unrecognised gets the general advice for its event.
"""
from __future__ import annotations

from typing import Any

APP_NAMES = {"sonarr": "Sonarr", "radarr": "Radarr", "seerr": "Seerr", "nzbget": "NZBGet", "sabnzbd": "SABnzbd"}

# id -> (button label, removes something from the download client)
ACTIONS: dict[str, tuple[str, bool]] = {
    "import": ("Import it", False),
    "redownload": ("Remove & search again", True),
    "remove": ("Remove", True),
    "retry_download": ("Retry download", False),
    "retry_request": ("Retry request", False),
    "test_connection": ("Test connection", False),
    "approve_request": ("Approve", False),
    "search_request": ("Search now", False),
    "clear_request": ("Clear", True),
}
DESTRUCTIVE = {a for a, (_, d) in ACTIONS.items() if d}


def _stuck(app: str, item: str, detail: str) -> tuple[str, list[str]]:
    d = detail.lower()
    if "matched to series by id" in d or "matched to movie by id" in d:
        return (f"{app} recognised this download only from its grab history — the release name didn't match "
                f"the title — so it won't import it on its own. Import it as the {item} {app} already matched, "
                f"or get a different release.", ["import", "redownload"])
    if "no files found are eligible" in d or "no video files" in d:
        return (f"{app} can't find importable files where the download client put them. Usually the download "
                f"didn't unpack, or {app} sees a different path than the download client (Settings → Download "
                f"Clients → Remote Path Mappings in {app}). If the files are there, try Import; otherwise get a "
                f"different release.", ["import", "redownload"])
    if "free space" in d or "disk space" in d:
        return (f"The disk {app} imports to is full. Free up space, then Import.", ["import"])
    if "not an upgrade" in d or "not a custom format upgrade" in d or "existing file" in d:
        return (f"You already have this {item} at the same or better quality, so {app} won't replace it. "
                f"Remove the download.", ["remove"])
    if "sample" in d:
        return ("Only a sample was downloaded, not the real file. Remove it, blocklist the release, and search "
                "for another.", ["redownload"])
    if "password" in d or "encrypted" in d:
        return ("The release is password-protected, so it can't be unpacked. Remove it, blocklist it, and search "
                "for another.", ["redownload"])
    if "unable to parse" in d or "not found in the grabbed release" in d or "unknown" in d:
        return (f"{app} couldn't work out which {item} this is from the file names. Import it as the {item} it "
                f"was grabbed for, or get a different release.", ["import", "redownload"])
    if "failed" in d or "download client" in d:
        return (f"The download failed in the download client. Remove it, blocklist the release, and let {app} "
                f"search for another.", ["redownload"])
    return (f"{app} is holding this download and won't finish it on its own. Import it anyway, or remove it and "
            f"search for a different release.", ["import", "redownload"])


def diagnose(problem: dict[str, Any]) -> dict[str, Any]:
    """{"advice": str, "actions": [{"id", "label", "destructive"}]} for one
    row of alert_conditions joined with its service's type and name."""
    kind = problem.get("service_type") or ""
    app = APP_NAMES.get(kind, kind)
    event = problem.get("event")
    detail = problem.get("detail") or ""
    key = problem.get("key") or ""
    advice, actions = "", []

    if event == "unreachable":
        advice = (f"Cortexarr can't reach {problem.get('service_name', app)}. Check it's running, then check the "
                  f"URL and {'username/password' if kind == 'nzbget' else 'API key'} under Services — a "
                  f"rejected key shows the same way. Test connection says which.")
        actions = ["test_connection"]
    elif event in ("error", "warning"):
        advice = (f"{app}'s own health check is reporting this. {app}'s System → Status page explains each item "
                  f"and links to its fix.")
    elif event == "stuck":
        advice, actions = _stuck(app, "episode" if kind == "sonarr" else "movie", detail)
    elif event == "download_failed":
        advice = (f"The download failed in {app}" + (f": {detail}." if detail else ".") +
                  " Retry it, or let Sonarr/Radarr search for a different release.")
        actions = ["retry_download"]
    elif event == "request_issue":
        if key.startswith("issue:request-"):
            advice = ("Seerr couldn't send this request on to Sonarr/Radarr. Fix the cause shown (often the "
                      "Sonarr/Radarr connection in Seerr's settings), then retry it — or Clear it if you don't "
                      "want it any more.")
            actions = ["retry_request", "clear_request"]
        else:
            advice = "Someone reported a problem with this title. Review it in Seerr."
    elif event == "stalled_approval":
        advice = "This request is waiting for someone to approve it. Approve it here, or decline it in Seerr."
        actions = ["approve_request", "clear_request"]
    elif event == "stalled_sending":
        advice = ("Seerr approved this request but it isn't in Sonarr/Radarr yet. Seerr usually sends it within "
                  "a minute — if it hasn't, check Seerr's Sonarr/Radarr settings (the server, quality profile and "
                  "root folder it sends to). If you don't want it any more — the title was deleted, say — Clear "
                  "removes the request from Seerr outright.")
        actions = ["clear_request"]
    elif event == "stalled_searching":
        advice = ("Sonarr/Radarr has this but hasn't found a release it will take. Search now to try again; if "
                  "nothing turns up, the indexers may not have it, or the quality profile may be too strict.")
        actions = ["search_request", "clear_request"]
    elif event == "stalled_downloading":
        advice = ("This has been downloading a long time. Check the download client — it may be paused, slow, or "
                  "stuck on a download with missing blocks.")
        actions = ["clear_request"]
    elif event == "stalled_importing":
        advice = ("The download finished but hasn't imported. It shows as a stuck queue item on Sonarr/Radarr — "
                  "fix it there with Import it or Remove & search again.")
        actions = ["clear_request"]

    return {"advice": advice, "actions": [
        {"id": a, "label": ACTIONS[a][0], "destructive": ACTIONS[a][1]} for a in actions
    ]}
