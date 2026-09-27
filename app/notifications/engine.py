"""
Alert engine (scope #3) — turns problems the poller sees into notifications,
by the rules users define (app/api/alerts.py). Called by the poller after
each service's health check.

Each check produces the service's current *conditions*: its own health
(unreachable / error / warning) and, when it's reachable, problem items —
queue items stuck in Sonarr/Radarr, failed downloads in NZBGet/SABnzbd,
failed requests and reported issues in Seerr. Conditions are kept in
alert_conditions with the time each was first seen; a rule fires once a
matching condition has lasted its threshold, and never twice for the same
one. When a state condition clears, rules that alerted on it can say so.

Two kinds of event:
  - state (unreachable, error, warning, stuck): true until it isn't — can
    be "resolved".
  - one-shot (download_failed, request_issue): something that happened.
    Fires once; only counts if it happened after Cortexarr started watching
    the service, so first run doesn't replay a day of old failures.

All of a rule's new matches from one check go out as one message, so a bad
night is one alert per rule, not one per item.

A rule can remind every N minutes while a problem lasts. A snoozed problem
(app/api/alerts.py) sends nothing — no alert, no reminder — until the
snooze ends; acknowledged means snoozed until it clears.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import aiosqlite

from app.notifications.sender import CHANNELS, Message, send
from app.services import nzbget_client, radarr_client, sabnzbd_client, seerr_client, sonarr_client
from app.services.errors import ConnectivityError, ServiceApiError

log = logging.getLogger("cortexarr.alerts")

STATE_EVENTS = ("unreachable", "error", "warning", "stuck")
ONESHOT_EVENTS = ("download_failed", "request_issue")
EVENTS = STATE_EVENTS + ONESHOT_EVENTS

EVENT_LABELS = {
    "unreachable": "unreachable",
    "error": "reporting an error",
    "warning": "reporting a warning",
    "stuck": "item stuck in the queue",
    "download_failed": "download failed",
    "request_issue": "request failed or issue reported",
}

# Same test as the dashboard cards' isStuck.
_FAILED_STATES = {"failed", "failedPending", "importBlocked"}
# A failure older than this is history, not news, even if it's new to us.
_ONESHOT_MAX_AGE = timedelta(days=2)
_MAX_LINES = 10


@dataclass
class Condition:
    key: str
    event: str
    title: str
    detail: str = ""


def _parse(ts: Any) -> Optional[datetime]:
    """ISO 8601 (Z or offset) or SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC)."""
    if not ts or not isinstance(ts, str):
        return None
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00").replace(" ", "T", 1))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _sql_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# What's wrong right now — per group, so a group whose fetch failed is left
# alone rather than read as "everything cleared".
# ---------------------------------------------------------------------------

def _health_conditions(service: aiosqlite.Row, status: str, summary: str) -> list[Condition]:
    if status not in ("unreachable", "error", "warning"):
        return []
    return [Condition(f"health:{status}", status, f"{service['name']} is {EVENT_LABELS[status]}", summary)]


async def _item_conditions(service: aiosqlite.Row, api_key: str, baseline: datetime) -> list[Condition]:
    kind, base_url = service["type"], service["base_url"]
    out: list[Condition] = []
    fresh_after = max(baseline, datetime.now(timezone.utc) - _ONESHOT_MAX_AGE)

    if kind in ("sonarr", "radarr"):
        client = sonarr_client if kind == "sonarr" else radarr_client
        for q in await client.get_queue(base_url, api_key):
            if q.get("tracked_status") in ("warning", "error") or q.get("tracked_state") in _FAILED_STATES:
                if kind == "sonarr":
                    title = f"{q.get('series', '')} — {q.get('episode', '')}"
                else:
                    title = f"{q.get('movie', '')}" + (f" ({q['year']})" if q.get("year") else "")
                out.append(Condition(f"stuck:{q.get('id')}", "stuck", title, "; ".join(q.get("messages") or [])))

    elif kind in ("nzbget", "sabnzbd"):
        client = nzbget_client if kind == "nzbget" else sabnzbd_client
        for h in await client.get_history(base_url, api_key):
            when = _parse(h.get("date"))
            if h.get("outcome") == "failure" and when and when >= fresh_after:
                out.append(Condition(f"failed:{h.get('id')}", "download_failed", h.get("name") or "",
                                     h.get("reason") or h.get("detail") or ""))

    elif kind == "seerr":
        for i in await seerr_client.get_issues(base_url, api_key):
            when = _parse(i.get("created_at"))
            if when and when >= fresh_after:
                title = i.get("title") or ""
                if i.get("source") == "reported":
                    title = f"{title} — {i.get('issue_type', 'issue')} reported by {i.get('reported_by', 'someone')}"
                else:
                    title = f"{title} — request failed"
                out.append(Condition(f"issue:{i.get('id')}", "request_issue", title, i.get("message") or ""))

    return out


async def _reconcile(db: aiosqlite.Connection, sid: int, prefix: str, now: list[Condition]) -> list[aiosqlite.Row]:
    """Record the group's current conditions; return the rows that cleared."""
    async with db.execute(
        "SELECT * FROM alert_conditions WHERE service_instance_id = ? AND key LIKE ?", (sid, prefix + "%"),
    ) as cur:
        existing = {r["key"]: r for r in await cur.fetchall()}
    stamp = _sql_now()
    for c in now:
        if c.key in existing:
            await db.execute(
                "UPDATE alert_conditions SET event = ?, title = ?, detail = ?, last_seen = ? "
                "WHERE service_instance_id = ? AND key = ?",
                (c.event, c.title[:500], c.detail[:2000], stamp, sid, c.key),
            )
        else:
            await db.execute(
                "INSERT INTO alert_conditions (service_instance_id, key, event, title, detail, first_seen, last_seen) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, c.key, c.event, c.title[:500], c.detail[:2000], stamp, stamp),
            )
    current = {c.key for c in now}
    cleared = [row for key, row in existing.items() if key not in current]
    return cleared


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

async def _targets(db: aiosqlite.Connection, channel: str) -> list[str]:
    """The per-user layer: every active user who turned this channel on."""
    async with db.execute(
        "SELECT p.target FROM user_notification_prefs p JOIN users u ON u.id = p.user_id "
        "WHERE p.channel = ? AND p.enabled = 1 AND u.is_active = 1 AND p.target != ''",
        (channel,),
    ) as cur:
        return [r[0] for r in await cur.fetchall()]


async def _stamp(db: aiosqlite.Connection) -> str:
    """Now, in the configured time zone (UTC when none is set)."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    async with db.execute("SELECT value FROM settings WHERE key = 'timezone'") as cur:
        row = await cur.fetchone()
    name = json.loads(row[0]) if row else ""
    try:
        zone = ZoneInfo(name) if name else timezone.utc
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    return datetime.now(zone).strftime("%Y-%m-%d %H:%M %Z")


def _message(service_name: str, event: str, kind: str, lines: list[tuple[str, str]], stamp: str = "") -> Message:
    label = EVENT_LABELS[event]
    if kind == "resolved":
        subject = f"[Cortexarr] {service_name}: resolved — no longer {label}"
        head = f"{service_name} is no longer {label}."
    else:
        still = "still " if kind == "reminder" else ""
        count = f" ({len(lines)})" if len(lines) > 1 else ""
        subject = f"[Cortexarr] {service_name}: {still}{label}{count}"
        head = f"{service_name}: {still}{label}."
    body_lines = [f"• {t}" + (f" — {d}" if d else "") for t, d in lines[:_MAX_LINES]]
    if len(lines) > _MAX_LINES:
        body_lines.append(f"…and {len(lines) - _MAX_LINES} more")
    text = "\n".join([head, *body_lines, *([f"— Cortexarr, {stamp}"] if stamp else [])])
    return Message(subject=subject, email_body=text, title=subject.removeprefix("[Cortexarr] "), text=text)


async def send_all(db: aiosqlite.Connection, rule: aiosqlite.Row | dict, msg: Message) -> dict[str, dict[str, str]]:
    """Send through each of the rule's channels. Only reads the database."""
    results: dict[str, dict[str, str]] = {}
    for channel in json.loads(rule["channels"] or "[]"):
        if channel in CHANNELS:
            results[channel] = await send(db, channel, msg, await _targets(db, channel))
    return results


async def log_sent(
    db: aiosqlite.Connection, rule: aiosqlite.Row | dict, service_id: Optional[int], service_name: str,
    event: str, kind: str, msg: Message, results: dict[str, dict[str, str]],
) -> None:
    await db.execute(
        "INSERT INTO alert_log (rule_id, rule_name, service_instance_id, service_name, event, kind, subject, body, results) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (rule["id"], rule["name"], service_id, service_name, event, kind, msg.subject, msg.text, json.dumps(results)),
    )


async def deliver(
    db: aiosqlite.Connection, rule: aiosqlite.Row | dict, service_id: Optional[int], service_name: str,
    event: str, kind: str, msg: Message,
) -> dict[str, dict[str, str]]:
    """Send, then log — for a one-off send like a rule's test."""
    results = await send_all(db, rule, msg)
    await log_sent(db, rule, service_id, service_name, event, kind, msg, results)
    return results


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

async def process(db: aiosqlite.Connection, service: aiosqlite.Row, api_key: str,
                  status: str, connectivity_ok: bool, summary: str) -> None:
    """After one health check: update the service's conditions, then fire
    whatever rules are now due.

    SQLite has one writer, and every page load writes a little (settings
    defaults, token last-used), so no network call — fetching queues and
    history, or sending a notification — ever happens while this holds a
    write transaction: fetch first, write briefly, send, write briefly."""
    sid = service["id"]
    await db.execute("INSERT OR IGNORE INTO alert_baselines (service_instance_id) VALUES (?)", (sid,))
    await db.commit()
    async with db.execute("SELECT started_at FROM alert_baselines WHERE service_instance_id = ?", (sid,)) as cur:
        baseline = _parse((await cur.fetchone())[0]) or datetime.now(timezone.utc)

    # 1. Network, no transaction. Item groups only when the service answered —
    #    an unreachable service hasn't cleared its stuck items, it just can't
    #    tell us about them.
    items: Optional[list[Condition]] = None
    if connectivity_ok:
        try:
            items = await _item_conditions(service, api_key, baseline)
        except (ConnectivityError, ServiceApiError) as exc:
            log.info("alert item scan skipped for service %s: %s", sid, exc)
    stamp = await _stamp(db)

    # 2. One short write: record what's wrong now, work out what to send.
    cleared = await _reconcile(db, sid, "health:", _health_conditions(service, status, summary))
    if items is not None:
        for prefix in ("stuck:", "failed:", "issue:"):
            cleared += await _reconcile(db, sid, prefix, [c for c in items if c.key.startswith(prefix)])

    async with db.execute(
        "SELECT * FROM alert_rules WHERE enabled = 1 AND (service_id IS NULL OR service_id = ?)", (sid,),
    ) as cur:
        rules = await cur.fetchall()

    outbox: list[tuple[aiosqlite.Row, str, Message]] = []   # (rule, kind for the log, message)
    notified: list[tuple[int, int, str, str]] = []

    # Resolved notices: state conditions that cleared, to rules that alerted on them.
    for rule in rules:
        if not rule["notify_resolved"] or rule["event"] not in STATE_EVENTS:
            continue
        gone = []
        for row in cleared:
            if row["event"] != rule["event"]:
                continue
            async with db.execute(
                "SELECT 1 FROM alert_notified WHERE rule_id = ? AND service_instance_id = ? AND key = ?",
                (rule["id"], sid, row["key"]),
            ) as cur:
                if await cur.fetchone():
                    gone.append((row["title"], ""))
        if gone:
            outbox.append((rule, "resolved", _message(service["name"], rule["event"], "resolved", gone, stamp)))

    for row in cleared:
        await db.execute("DELETE FROM alert_conditions WHERE service_instance_id = ? AND key = ?", (sid, row["key"]))
        await db.execute("DELETE FROM alert_notified WHERE service_instance_id = ? AND key = ?", (sid, row["key"]))
        await db.execute("DELETE FROM alert_snoozes WHERE service_instance_id = ? AND key = ?", (sid, row["key"]))

    # Due alerts: conditions that have lasted the rule's threshold and either
    # haven't been sent, or are due a reminder — unless someone snoozed them.
    now = _sql_now()
    for rule in rules:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=rule["threshold_minutes"])).strftime("%Y-%m-%d %H:%M:%S")
        remind = (datetime.now(timezone.utc) - timedelta(minutes=rule["repeat_minutes"])).strftime("%Y-%m-%d %H:%M:%S")
        async with db.execute(
            "SELECT c.*, n.sent_at AS sent_at FROM alert_conditions c "
            "LEFT JOIN alert_notified n ON n.rule_id = ? AND n.service_instance_id = c.service_instance_id AND n.key = c.key "
            "WHERE c.service_instance_id = ? AND c.event = ? AND c.first_seen <= ? "
            "AND (n.sent_at IS NULL OR (? > 0 AND n.sent_at <= ?)) "
            "AND NOT EXISTS (SELECT 1 FROM alert_snoozes z WHERE z.service_instance_id = c.service_instance_id "
            "                AND z.key = c.key AND (z.until IS NULL OR z.until > ?)) "
            "ORDER BY c.first_seen",
            # One-shot events never remind — a failed download doesn't get more failed.
            (rule["id"], sid, rule["event"], cutoff,
             rule["repeat_minutes"] if rule["event"] in STATE_EVENTS else 0, remind, now),
        ) as cur:
            due = await cur.fetchall()
        for kind in ("alert", "reminder"):
            batch = [r for r in due if (r["sent_at"] is None) == (kind == "alert")]
            if batch:
                outbox.append((rule, "alert", _message(service["name"], rule["event"], kind,
                                                       [(r["title"], r["detail"]) for r in batch], stamp)))
        notified += [(rule["id"], sid, r["key"], now) for r in due]
    await db.commit()

    # 3. Network again, outside any transaction: send.
    sent = []
    for rule, kind, msg in outbox:
        sent.append((rule, kind, msg, await send_all(db, rule, msg)))

    # 4. One short write: remember what went out.
    for rule, kind, msg, results in sent:
        await log_sent(db, rule, sid, service["name"], rule["event"], kind, msg, results)
    await db.executemany(
        "INSERT INTO alert_notified (rule_id, service_instance_id, key, sent_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(rule_id, service_instance_id, key) DO UPDATE SET sent_at = excluded.sent_at",
        notified,
    )
    await db.commit()


async def forget_paused(db: aiosqlite.Connection) -> None:
    """A service in maintenance or disabled isn't being checked, so what we
    last saw of it is stale: drop it quietly — maintenance means no alerts,
    including no "resolved" when it comes back."""
    paused = "SELECT id FROM service_instances WHERE enabled = 0 OR maintenance_mode = 1"
    await db.execute(f"DELETE FROM alert_conditions WHERE service_instance_id IN ({paused})")
    await db.execute(f"DELETE FROM alert_notified WHERE service_instance_id IN ({paused})")
    await db.execute(f"DELETE FROM alert_snoozes WHERE service_instance_id IN ({paused})")
    await db.commit()


async def sample_message(db: aiosqlite.Connection, rule: aiosqlite.Row | dict, service_name: str) -> Message:
    """What the rule's alert will look like, for its Send test button."""
    msg = _message(service_name, rule["event"], "alert", [("Example item", "this is a test of the alert rule")],
                   await _stamp(db))
    return Message(subject=f"[Cortexarr Test] {msg.subject.removeprefix('[Cortexarr] ')}",
                   email_body=msg.email_body, title=f"Test: {msg.title}", text=f"(Test) {msg.text}")
