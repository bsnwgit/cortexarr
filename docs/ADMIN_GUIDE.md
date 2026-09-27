# Cortexarr — Admin Guide

## Adding a monitored service

Open the user menu (your username, top right) → **Add service**, pick a
type (Sonarr, Radarr, Seerr, NZBGet, or SABnzbd), give it a name, base URL,
and API key, then
**Test connection** before saving — this checks the URL and key actually
work, and that the URL really is the type you picked. The API key is under
*Settings → General* in Sonarr, Radarr, and Seerr.

NZBGet has no API key: it asks for NZBGet's own login instead — the
`ControlUsername` / `ControlPassword` from *Settings → Security* in NZBGet.
It's stored encrypted, like the API keys. NZBGet's health comes from its
own configuration check (NZBGet 26+) plus whether downloads are paused or
the download quota is reached.

SABnzbd uses a normal API key (*Config → General* in SABnzbd). Its health
comes from SABnzbd's own active warnings from the last day (e.g. a news
server login failing) plus whether downloads are paused.

Seerr has no health endpoint of its own; its status shows **Warning** when
Seerr reports an available update or a pending restart.

Each service instance has its own poll interval and retry/backoff settings,
so a fast-changing instance can be checked more often than a slow one
without affecting the others.

The **Services** page (user menu → *Services* → **Manage services**) lists every service with **Test** (re-run the
connection check), **Maintenance mode**, and **Delete**.

A read-only JSON summary of every service's health is served, without
login, at `/api/status/` — for embedding in a homelab dashboard.

## Maintenance mode

Toggling **Maintenance mode** on a service pauses health checks and drops
it out of the overall status on the public status endpoint, without
deleting its configuration. Use this when you know a service is down for a
planned reason and don't want alerts about it.

## Notifications

Under **Settings** (user menu), each channel (email, webhook, ntfy, SMS) is
configured and enabled independently, with a **Send test** button to
confirm it actually works before relying on it.

**Settings → General → Time zone** sets the zone every time in Cortexarr is
shown in — tables, calendars (which day an episode lands on), and the
timestamp at the foot of each alert. Left on *Browser default*, each viewer
sees their own local time and alert messages are stamped in UTC.

### Alert rules

Nothing is sent until you add a rule: user menu → **Alerts** → **New
rule**. A rule is:

- **When** — one of:
  - *Service unreachable* — can't connect, or the key/login is rejected.
  - *Service reports an error* / *a warning* — the service's own health
    check (an indexer down, a news server failing, …).
  - *Queue item stuck* — a Sonarr/Radarr download or import in warning or
    failed (e.g. "not enough free space").
  - *Download failed* — NZBGet/SABnzbd.
  - *Request failed or issue reported* — Seerr.
- **On** — every service, or one.
- **For at least** — how many minutes it must last before alerting; 0
  alerts on the first check that sees it. Checks run at each service's
  poll interval, so that's the resolution.
- **Send through** — any of the configured channels. Users who turned a
  channel on for themselves under their notification preferences get it
  too.
- **Remind every** — resend while the problem lasts, every so many
  minutes; 0 alerts once. Only for problems that can clear.
- **Also send when it clears** — for problems that can clear (the first
  four); failed downloads and requests are one-off events.

Each problem alerts once per rule, not on every check. Everything a rule
finds in one check goes out as one message. Failed downloads and Seerr
issues only count if they happened after Cortexarr started watching that
service, so adding a rule doesn't replay old failures. A service in
**maintenance mode** is ignored completely — no alerts, and no "resolved"
when it comes back.

### Fixing problems

Each current problem says what's likely wrong, in plain words read from the
message the service gave, and offers the fixes Cortexarr can apply (admins
only; each is in the audit log):

- **Import it** — a stuck Sonarr/Radarr download (e.g. "matched to series
  by ID, automatic import is not possible", or after freeing disk space):
  imports it as the episode or movie the app already matched, the same as
  its own Interactive Import. Samples are skipped. If the app can't tell
  which episodes a multi-file download is, it says so — use Interactive
  Import in the app for that one.
- **Remove & search again** — removes the download from the queue and the
  download client, blocklists the release, and searches for another. Asks
  you to type `Delete` first.
- **Remove** — for a download you don't need (e.g. not an upgrade). Asks
  you to type `Delete` first.
- **Retry download** / **Retry request** — a failed NZBGet/SABnzbd download,
  or a failed Seerr request.
- **Test connection** — for an unreachable service; says whether it's the
  network or the key.

A link opens the right page in the app itself (its queue, or System →
Status for health warnings). A fixed problem clears at the service's next
check.

**Many at once:** tick problems to fix or snooze them together. Only
problems with exactly the same fixes can be selected together — once one is
ticked, the others grey out — so one action means the same thing for every
one. **Select all that fix the same way** picks a whole group in one click
(e.g. every "Import it" problem). Several stuck episodes from one download
(a season pack) are handled once, and each problem shows how its fix went.

### Snooze and acknowledge

Each current problem on the Alerts page has **Snooze**: silence it for an
hour, 4 hours, a day, a week, a number of hours you type, or **until it
clears** (acknowledged) — with an optional note saying why. A snoozed
problem stays listed, marked with who snoozed it and until when; it just
doesn't alert or remind. When a timed snooze runs out and the problem is
still there, reminders pick up again. **Unsnooze** undoes it. A "resolved"
message is still sent when an acknowledged problem clears. Admins and
analysts can snooze; every snooze is in the audit log.

The Alerts page also shows **current problems** (what Cortexarr sees
wrong right now, and for how long) and **recently sent** alerts with each
channel's result. **Send test** on a rule sends a sample of its alert
through its channels.

## Users and roles

- **admin** — everything: add and manage services, settings, users, and
  every action on a service (monitor, search, delete, approve/decline,
  retry, pause/resume).
- **analyst** / **viewer** — can see every page, but can't change anything.
  (The analyst role is reserved for future operational actions; today it
  has the same access as viewer.)

Manage users via `/api/users` (a dedicated admin page is planned).

## MCP server and API tokens

Cortexarr serves MCP (streamable HTTP) at `/mcp`, on the same port as the
web UI. Every tool is a web-UI action, run through the same code with the
same checks, so there's nothing an AI tool can do that its token's owner
couldn't do by hand. How users make tokens is in the
[User Guide](USER_GUIDE.md#api-tokens-and-ai-tools).

- An admin's **API tokens** page lists every user's tokens and can revoke
  any of them — a leaked token has to be stoppable by someone other than
  its owner.
- Only admins can make write tokens, or tokens that allow destructive tools.
- Only a hash of each token is stored; a lost token is revoked and remade,
  not recovered.
- Requests from a web page on another site (a foreign `Origin` header) are
  refused.
- If Cortexarr sits behind a reverse proxy, forward `/mcp` as well as `/`
  and `/api`.

## Audit log

Every change made in Cortexarr — services added or changed, monitor
toggles, searches, deletes, approvals, retries, pauses, settings — is
recorded under **Logs → Audit Log** with who did it and when.
