"""
The MCP tool catalogue — one tool per thing a user can do in the web UI
(scope #6b: parity, not a read-only subset).

Every tool calls the same route handler the web UI calls, with the token's
owner standing in for the signed-in user. So validation, the 404/400/502
shapes, and the audit records are the web UI's own — there is no second
path to a monitored service. The only rules added here are the ones a
FastAPI dependency would otherwise have applied: the owner's role, and the
token's access level.

Three things are deliberately left out: changing the account password (a
leaked token must not be able to lock its owner out), managing API tokens
(a token must not be able to mint another), and signing in/out, which
tokens replace.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional

import aiosqlite
from pydantic import BaseModel, EmailStr, Field

from app.api import alerts as alerts_api
from app.api import audit as audit_api
from app.api import services as svc
from app.api import settings as settings_api
from app.api import status as status_api
from app.api import users as users_api

ROLE_RANK = {"viewer": 0, "analyst": 1, "admin": 2}

# Mirrors ActivityFeed.tsx — the service types with a history view.
_HISTORY_TYPES = {"sonarr", "radarr", "seerr", "nzbget", "sabnzbd"}

ISO_DATE = r"^\d{4}-\d{2}-\d{2}$"


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[BaseModel]
    run: Callable[[aiosqlite.Connection, dict, Any], Awaitable[Any]]
    min_role: str = "viewer"
    # read: changes nothing. write: changes something. destructive: deletes
    # something that can't be put back from here (files, library entries).
    kind: Literal["read", "write", "destructive"] = "read"

    def input_schema(self) -> dict[str, Any]:
        return _slim(self.args.model_json_schema())


def _slim(node: Any) -> Any:
    """Pydantic's schema, minus what a model doesn't need: every tool list is
    sent with every chat turn, and small local models have small context
    windows. Drops the auto-generated titles, and turns Optional[X]'s
    anyOf-with-null into plain X (omitting the field already means "none")."""
    if isinstance(node, list):
        return [_slim(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key == "title" or (key == "default" and value is None):
            continue
        if key == "anyOf" and isinstance(value, list):
            kept = [v for v in value if v != {"type": "null"}]
            if len(kept) == 1:
                out.update(_slim(kept[0]))
                continue
        # "properties" maps field names to schemas — a field may itself be
        # called "title", so only schema keys are filtered, never names.
        out[key] = {k: _slim(v) for k, v in value.items()} if key == "properties" else _slim(value)
    return out


# ---------------------------------------------------------------------------
# Argument shapes
# ---------------------------------------------------------------------------

class NoArgs(BaseModel):
    pass


class ServiceArg(BaseModel):
    service_id: int = Field(description="Service id, from list_services")


class ServiceFilter(BaseModel):
    type: Optional[Literal["sonarr", "radarr", "seerr", "nzbget", "sabnzbd"]] = None
    q: Optional[str] = Field(default=None, max_length=100, description="Name contains")


class HealthArgs(ServiceArg):
    limit: int = Field(default=20, ge=1, le=200)


class ViewArgs(ServiceArg):
    view: Literal["queue", "wanted", "series", "movies", "history", "requests", "issues", "overview"] = Field(
        description=(
            "queue (Sonarr/Radarr/NZBGet/SABnzbd), wanted = missing (Sonarr/Radarr), "
            "series (Sonarr library), movies (Radarr library), history (all types), "
            "requests and issues (Seerr), overview (NZBGet/SABnzbd speed, disk, paused)"
        ),
    )


class RangeArgs(ServiceArg):
    start: str = Field(pattern=ISO_DATE, description="YYYY-MM-DD")
    end: str = Field(pattern=ISO_DATE, description="YYYY-MM-DD")


class SeriesArgs(ServiceArg):
    series_id: int


class SeriesRangeArgs(SeriesArgs):
    start: str = Field(pattern=ISO_DATE, description="YYYY-MM-DD")
    end: str = Field(pattern=ISO_DATE, description="YYYY-MM-DD")


class SeasonArgs(SeriesArgs):
    season_number: int = Field(ge=0, description="0 is Specials")


class MovieArgs(ServiceArg):
    movie_id: int


class EpisodeArgs(ServiceArg):
    episode_id: int


class ActivityArgs(BaseModel):
    limit: int = Field(default=50, ge=1, le=500)
    type: Optional[Literal["sonarr", "radarr", "seerr", "nzbget", "sabnzbd"]] = Field(
        default=None, description="Only this pipeline")


class LimitArgs(BaseModel):
    limit: int = Field(default=100, ge=1, le=1000)


class NewServiceTest(BaseModel):
    type: Literal["sonarr", "radarr", "seerr", "nzbget", "sabnzbd"]
    base_url: str = Field(max_length=500)
    api_key: str = Field(max_length=500, description="API key; for NZBGet, username:password")


class AddServiceArgs(NewServiceTest):
    name: str = Field(min_length=1, max_length=100)
    poll_interval_seconds: int = Field(default=60, ge=10)
    retry_count: int = Field(default=3, ge=0, le=10)
    retry_backoff_seconds: int = Field(default=5, ge=1)


class UpdateServiceArgs(ServiceArg):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    base_url: Optional[str] = Field(default=None, max_length=500)
    api_key: Optional[str] = Field(default=None, max_length=500)
    enabled: Optional[bool] = None
    maintenance_mode: Optional[bool] = Field(default=None, description="Pause checks and alerts for this service")
    poll_interval_seconds: Optional[int] = Field(default=None, ge=10)
    retry_count: Optional[int] = Field(default=None, ge=0, le=10)
    retry_backoff_seconds: Optional[int] = Field(default=None, ge=1)


class MonitorSeriesArgs(SeriesArgs):
    monitored: bool


class MonitorSeasonArgs(SeasonArgs):
    monitored: bool


class MonitorEpisodeArgs(EpisodeArgs):
    monitored: bool


class MonitorMovieArgs(MovieArgs):
    monitored: bool


class DeleteSeriesArgs(SeriesArgs):
    delete_files: bool = Field(default=False, description="Also delete the files on disk")


class DeleteMovieArgs(MovieArgs):
    delete_files: bool = Field(default=False, description="Also delete the files on disk")


class EpisodeFileArgs(ServiceArg):
    episode_file_id: int


class MovieFileArgs(ServiceArg):
    movie_file_id: int


class RequestActionArgs(ServiceArg):
    request_id: int
    action: Literal["approve", "decline", "retry"] = Field(
        description="approve/decline: pending requests only; retry: failed requests")


class DownloadItemArgs(ServiceArg):
    item_id: str = Field(max_length=100, pattern=r"^[A-Za-z0-9_\-]+$",
                         description="Queue or history item id, from the queue/history view")


class DownloadActionArgs(DownloadItemArgs):
    action: Literal["pause", "resume", "top", "retry"] = Field(
        description="pause/resume/top: queue items; retry: failed history items")


class DownloadControlArgs(ServiceArg):
    action: Literal["pause", "resume"] = Field(description="Pause or resume all downloading")


class SettingsArgs(BaseModel):
    updates: dict[str, Any] = Field(description="Setting key -> new value; keys as returned by get_settings")


class ChannelArgs(BaseModel):
    channel: Literal["email", "webhook", "ntfy", "sms"]


class NotificationPrefArgs(ChannelArgs):
    enabled: bool
    target: str = Field(default="", max_length=500, description="Address / URL / topic / phone number")


class RuleIdArgs(BaseModel):
    rule_id: int = Field(description="Rule id, from list_alert_rules")


class UpdateRuleArgs(RuleIdArgs, alerts_api.RuleUpdate):
    pass


class FixArgs(ServiceArg):
    key: str = Field(min_length=1, max_length=200, description="The problem's key, from get_active_problems")
    action: Literal["import", "retry_download", "retry_request", "test_connection"] = Field(
        description="One of the problem's suggested actions")


class RemoveStuckArgs(ServiceArg):
    key: str = Field(min_length=1, max_length=200, description="The stuck item's key, from get_active_problems")
    action: Literal["remove", "redownload"] = Field(
        description="remove: drop it; redownload: drop it, blocklist the release, search for another")


class BulkFixArgs(BaseModel):
    items: list[alerts_api.ProblemRef] = Field(min_length=1, max_length=500,
                                               description="Problems as {service_id, key}, from get_active_problems")
    action: Literal["import", "retry_download", "retry_request", "test_connection"]


class BulkRemoveArgs(BaseModel):
    items: list[alerts_api.ProblemRef] = Field(min_length=1, max_length=500)
    action: Literal["remove", "redownload"]


class UnsnoozeArgs(ServiceArg):
    key: str = Field(min_length=1, max_length=200)


class CreateUserArgs(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    role: Literal["admin", "analyst", "viewer"] = "viewer"


class UpdateUserArgs(BaseModel):
    user_id: int
    role: Optional[Literal["admin", "analyst", "viewer"]] = None
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Handlers — each one a web-UI route, called with the owner as the user
# ---------------------------------------------------------------------------

async def _whoami(db, user, a):
    return {"id": user["id"], "username": user["account"], "role": user["role"], "token": user["token_name"]}


async def _activity(db, user, a: ActivityArgs):
    """The Logs > Activities feed, merged server-side the way ActivityFeed.tsx
    merges it: every service's history, newest first."""
    services = await svc.list_services(user=user, db=db, type=a.type, q=None)
    rows: list[dict] = []
    for s in services:
        if s["type"] not in _HISTORY_TYPES:
            continue
        try:
            history = await svc.service_detail(service_id=s["id"], view="history", user=user, db=db)
        except Exception:
            continue  # one unreachable service shouldn't blank the whole feed
        for r in history:
            rows.append({**r, "service_id": s["id"], "service_name": s["name"], "service_type": s["type"]})
    rows.sort(key=lambda r: r.get("date") or "", reverse=True)
    return rows[: a.limit]


def _fields(a: BaseModel, *drop: str) -> dict:
    return a.model_dump(exclude={"service_id", *drop})


TOOLS: list[Tool] = [
    # -- Account ------------------------------------------------------------
    Tool("whoami", "Who this token acts as, and their role.", NoArgs, _whoami),

    # -- Dashboard / status -------------------------------------------------
    Tool("get_status",
         "Overall pipeline health and each service's latest status (ok / warning / error / unreachable), "
         "maintenance mode, and when it was last checked — what the Dashboard shows.",
         NoArgs, lambda db, u, a: status_api.status_summary(db=db)),
    Tool("list_services", "Every monitored service: id, name, type, URL, poll settings, maintenance mode.",
         ServiceFilter, lambda db, u, a: svc.list_services(user=u, db=db, type=a.type, q=a.q)),
    Tool("get_service", "One monitored service's configuration.",
         ServiceArg, lambda db, u, a: svc.get_service(a.service_id, u, db)),
    Tool("get_service_health",
         "Recent health checks for one service, newest first — connectivity, status, and the issues the "
         "service itself reported (indexer errors, import failures, news-server problems…).",
         HealthArgs, lambda db, u, a: svc.latest_health(a.service_id, u, db, a.limit)),
    Tool("get_activity",
         "Recent activity across every service, newest first — grabs, imports, failures, requests (Logs > Activities).",
         ActivityArgs, _activity),

    # -- Service pages (live views) ------------------------------------------
    Tool("get_service_view",
         "A live view from one service, as on its page: its download queue, missing items, library, history, "
         "Seerr requests/issues, or a download client's overview.",
         ViewArgs, lambda db, u, a: svc.service_detail(a.service_id, a.view, u, db)),
    Tool("get_calendar", "Sonarr/Radarr calendar entries between two dates.",
         RangeArgs, lambda db, u, a: svc.service_calendar(a.service_id, a.start, a.end, u, db)),
    Tool("get_series", "One Sonarr series with its season breakdown.",
         SeriesArgs, lambda db, u, a: svc.series_detail(a.service_id, a.series_id, u, db)),
    Tool("get_season_episodes", "The episodes of one season, with file and monitored state.",
         SeasonArgs, lambda db, u, a: svc.season_episodes(a.service_id, a.series_id, a.season_number, u, db)),
    Tool("get_season_history", "Grab/import/failure history for one season.",
         SeasonArgs, lambda db, u, a: svc.season_history(a.service_id, a.series_id, a.season_number, u, db)),
    Tool("get_series_history", "Grab/import/failure history for a whole series.",
         SeriesArgs, lambda db, u, a: svc.series_history(a.service_id, a.series_id, u, db)),
    Tool("get_series_calendar", "Calendar entries for one series between two dates.",
         SeriesRangeArgs,
         lambda db, u, a: svc.series_calendar(a.service_id, a.series_id, a.start, a.end, u, db)),
    Tool("get_movie", "One Radarr movie: summary, release dates, and the file on disk.",
         MovieArgs, lambda db, u, a: svc.movie_detail(a.service_id, a.movie_id, u, db)),
    Tool("get_movie_history", "Grab/import/failure history for one movie.",
         MovieArgs, lambda db, u, a: svc.movie_history(a.service_id, a.movie_id, u, db)),

    # -- Settings / notifications (read) --------------------------------------
    Tool("get_settings", "Global settings: notification channels, batching, retention. Secrets come back masked.",
         NoArgs, lambda db, u, a: settings_api.get_all_settings(u, db)),
    Tool("get_my_notification_prefs", "This user's own notification channels and targets.",
         NoArgs, lambda db, u, a: users_api.get_my_notification_prefs(u, db)),

    # -- Alerts (read) --------------------------------------------------------
    Tool("get_active_problems",
         "What's wrong right now, as the alert engine sees it: unreachable/erroring services, stuck queue items, "
         "recent failed downloads, failed requests and reported issues — with when each was first seen.",
         NoArgs, lambda db, u, a: alerts_api.active_problems(u, db)),
    Tool("list_alert_rules", "The alert rules: which event, which service, threshold, channels.",
         NoArgs, lambda db, u, a: alerts_api.list_rules(u, db)),
    Tool("get_alert_log", "Alerts sent, newest first, with each channel's result.",
         LimitArgs, lambda db, u, a: alerts_api.alert_log(u, db, a.limit)),

    # -- Admin reads ----------------------------------------------------------
    Tool("get_audit_log", "Configuration changes: who changed what, newest first.",
         LimitArgs, lambda db, u, a: audit_api.list_audit_log(u, db, a.limit), min_role="admin"),
    Tool("list_users", "Every Cortexarr user and their role.",
         NoArgs, lambda db, u, a: users_api.list_users(u, db), min_role="admin"),
    Tool("test_service_connection", "Re-run the connection check for a saved service.",
         ServiceArg, lambda db, u, a: svc.test_connection_saved(a.service_id, u, db), min_role="admin"),
    Tool("test_new_service_connection",
         "Check a URL and key work before adding a service, and that the URL really is that type.",
         NewServiceTest,
         lambda db, u, a: svc.test_connection_unsaved(svc.TestConnectionRequest(**a.model_dump()), u),
         min_role="admin"),

    # -- Writes ---------------------------------------------------------------
    Tool("add_service", "Add a monitored service. Refused if the URL is a different type of app.",
         AddServiceArgs, lambda db, u, a: svc.create_service(svc.ServiceCreate(**a.model_dump()), u, db),
         min_role="admin", kind="write"),
    Tool("update_service",
         "Change a service's name, URL, key, polling, enabled, or maintenance mode. Omitted fields are left alone.",
         UpdateServiceArgs,
         lambda db, u, a: svc.update_service(a.service_id, svc.ServiceUpdate(**_fields(a)), u, db),
         min_role="admin", kind="write"),
    Tool("set_series_monitored", "Monitor or unmonitor a whole series.",
         MonitorSeriesArgs,
         lambda db, u, a: svc.update_series_monitored(
             a.service_id, a.series_id, svc.SeriesMonitorUpdate(monitored=a.monitored), u, db),
         min_role="admin", kind="write"),
    Tool("set_season_monitored", "Monitor or unmonitor one season.",
         MonitorSeasonArgs,
         lambda db, u, a: svc.update_season_monitored(
             a.service_id, a.series_id, a.season_number, svc.SeasonMonitorUpdate(monitored=a.monitored), u, db),
         min_role="admin", kind="write"),
    Tool("set_episode_monitored", "Monitor or unmonitor one episode.",
         MonitorEpisodeArgs,
         lambda db, u, a: svc.update_episode_monitored(
             a.service_id, a.episode_id, svc.EpisodeMonitorUpdate(monitored=a.monitored), u, db),
         min_role="admin", kind="write"),
    Tool("set_movie_monitored", "Monitor or unmonitor a movie.",
         MonitorMovieArgs,
         lambda db, u, a: svc.update_movie_monitored(
             a.service_id, a.movie_id, svc.MovieMonitorUpdate(monitored=a.monitored), u, db),
         min_role="admin", kind="write"),
    Tool("search_season", "Tell Sonarr to search for a season now.",
         SeasonArgs, lambda db, u, a: svc.trigger_season_search(a.service_id, a.series_id, a.season_number, u, db),
         min_role="admin", kind="write"),
    Tool("search_episode", "Tell Sonarr to search for one episode now.",
         EpisodeArgs, lambda db, u, a: svc.trigger_episode_search(a.service_id, a.episode_id, u, db),
         min_role="admin", kind="write"),
    Tool("search_movie", "Tell Radarr to search for a movie now.",
         MovieArgs, lambda db, u, a: svc.trigger_movie_search(a.service_id, a.movie_id, u, db),
         min_role="admin", kind="write"),
    Tool("seerr_request_action", "Approve or decline a pending Seerr request, or retry a failed one.",
         RequestActionArgs, lambda db, u, a: svc.request_action(a.service_id, a.request_id, a.action, u, db),
         min_role="admin", kind="write"),
    Tool("download_action",
         "Pause, resume, or move to the top one download client queue item, or retry a failed history item.",
         DownloadActionArgs,
         lambda db, u, a: svc.download_action(service_id=a.service_id, action=a.action, admin=u,
                                              item_id=a.item_id, db=db),
         min_role="admin", kind="write"),
    Tool("download_control", "Pause or resume all downloading on a download client.",
         DownloadControlArgs, lambda db, u, a: svc.download_control(a.service_id, a.action, u, db),
         min_role="admin", kind="write"),
    Tool("update_settings", "Change global settings. Keys as returned by get_settings.",
         SettingsArgs, lambda db, u, a: settings_api.bulk_update(a.updates, u, db),
         min_role="admin", kind="write"),
    Tool("send_test_notification", "Send a test alert through one notification channel.",
         ChannelArgs,
         lambda db, u, a: settings_api.test_notification(settings_api.TestNotificationRequest(channel=a.channel), u, db),
         min_role="admin", kind="write"),
    Tool("set_my_notification_pref", "Turn one of this user's own notification channels on or off, and set its target.",
         NotificationPrefArgs,
         lambda db, u, a: users_api.set_my_notification_pref(users_api.NotificationPref(**a.model_dump()), u, db),
         kind="write"),
    Tool("create_alert_rule",
         "Add an alert rule. Events: unreachable, error, warning (a service's health), stuck (Sonarr/Radarr queue "
         "item), download_failed (NZBGet/SABnzbd), request_issue (Seerr). threshold_minutes: how long it must "
         "persist first. Omit service_id for every service.",
         alerts_api.RuleIn, lambda db, u, a: alerts_api.create_rule(a, u, db),
         min_role="admin", kind="write"),
    Tool("update_alert_rule", "Change an alert rule. Omitted fields are left alone; all_services=true clears service_id.",
         UpdateRuleArgs,
         lambda db, u, a: alerts_api.update_rule(
             a.rule_id, alerts_api.RuleUpdate(**a.model_dump(exclude={"rule_id"}, exclude_none=True)), u, db),
         min_role="admin", kind="write"),
    Tool("delete_alert_rule", "Delete an alert rule.",
         RuleIdArgs, lambda db, u, a: alerts_api.delete_rule(a.rule_id, u, db),
         min_role="admin", kind="write"),
    Tool("test_alert_rule", "Send a sample of a rule's alert through its channels now.",
         RuleIdArgs, lambda db, u, a: alerts_api.test_rule(a.rule_id, u, db),
         min_role="admin", kind="write"),
    Tool("snooze_problem",
         "Silence one current problem (from get_active_problems) for some minutes, or omit minutes to "
         "acknowledge it until it clears. It stays listed; it just stops alerting and reminding.",
         alerts_api.SnoozeIn, lambda db, u, a: alerts_api.snooze(a, u, db),
         min_role="analyst", kind="write"),
    Tool("unsnooze_problem", "Remove a snooze or acknowledgement, so the problem can alert again.",
         UnsnoozeArgs, lambda db, u, a: alerts_api.unsnooze(a.service_id, a.key, u, db),
         min_role="analyst", kind="write"),
    Tool("fix_problem",
         "Apply one of a current problem's suggested fixes (see its 'actions' in get_active_problems): import a "
         "stuck download as what Sonarr/Radarr matched, retry a failed download or Seerr request, or test a "
         "service's connection.",
         FixArgs, lambda db, u, a: alerts_api.fix(alerts_api.FixIn(**a.model_dump()), u, db),
         min_role="admin", kind="write"),
    Tool("remove_stuck_item",
         "Remove a stuck Sonarr/Radarr queue item from the queue and download client — optionally blocklisting "
         "the release and searching for another (redownload).",
         RemoveStuckArgs, lambda db, u, a: alerts_api.fix(alerts_api.FixIn(**a.model_dump()), u, db),
         min_role="admin", kind="destructive"),
    Tool("fix_problems",
         "Apply one fix to many current problems at once (e.g. import every stuck item). All the problems must "
         "have the same set of actions in get_active_problems. Downloads shared by several items are handled "
         "once. Returns how each went.",
         BulkFixArgs, lambda db, u, a: alerts_api.fix_bulk(alerts_api.BulkFixIn(**a.model_dump()), u, db),
         min_role="admin", kind="write"),
    Tool("remove_stuck_items",
         "Remove many stuck Sonarr/Radarr queue items from the queue and download client at once — optionally "
         "blocklisting each release and searching for another (redownload).",
         BulkRemoveArgs, lambda db, u, a: alerts_api.fix_bulk(alerts_api.BulkFixIn(**a.model_dump()), u, db),
         min_role="admin", kind="destructive"),
    Tool("snooze_problems", "Snooze or acknowledge many current problems at once; all must have the same set of actions.",
         alerts_api.BulkSnoozeIn, lambda db, u, a: alerts_api.snooze_bulk(a, u, db),
         min_role="analyst", kind="write"),
    Tool("create_user", "Add a Cortexarr user.",
         CreateUserArgs, lambda db, u, a: users_api.create_user(users_api.CreateUser(**a.model_dump()), u, db),
         min_role="admin", kind="write"),
    Tool("update_user", "Change a user's role, or deactivate/reactivate them.",
         UpdateUserArgs,
         lambda db, u, a: users_api.update_user(a.user_id, users_api.UpdateUser(role=a.role, is_active=a.is_active), u, db),
         min_role="admin", kind="write"),

    # -- Destructive ------------------------------------------------------------
    Tool("delete_service", "Stop monitoring a service and delete its configuration and health history.",
         ServiceArg, lambda db, u, a: svc.delete_service(a.service_id, u, db),
         min_role="admin", kind="destructive"),
    Tool("delete_series", "Remove a series from Sonarr, and optionally delete its files from disk.",
         DeleteSeriesArgs,
         lambda db, u, a: svc.delete_series_route(a.service_id, a.series_id, u, db, a.delete_files),
         min_role="admin", kind="destructive"),
    Tool("delete_movie", "Remove a movie from Radarr, and optionally delete its files from disk.",
         DeleteMovieArgs,
         lambda db, u, a: svc.delete_movie_route(a.service_id, a.movie_id, u, db, a.delete_files),
         min_role="admin", kind="destructive"),
    Tool("delete_episode_file", "Delete one episode's file from disk (the episode stays, as missing).",
         EpisodeFileArgs, lambda db, u, a: svc.delete_episode_file_route(a.service_id, a.episode_file_id, u, db),
         min_role="admin", kind="destructive"),
    Tool("delete_movie_file", "Delete a movie's file from disk (the movie stays, as missing).",
         MovieFileArgs, lambda db, u, a: svc.delete_movie_file_route(a.service_id, a.movie_file_id, u, db),
         min_role="admin", kind="destructive"),
    Tool("delete_download", "Delete an item from a download client's queue.",
         DownloadItemArgs,
         lambda db, u, a: svc.download_action(service_id=a.service_id, action="delete", admin=u,
                                              item_id=a.item_id, db=db),
         min_role="admin", kind="destructive"),
]

BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}
assert len(BY_NAME) == len(TOOLS), "duplicate MCP tool name"
