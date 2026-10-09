# Cortexarr — Admin Guide

## Adding a monitored service

User menu → **Settings** → **Services** → **New service**. Pick a
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

**Settings → Services** lists every service with **Test** (re-run the
connection check), **Maintenance mode**, and **Delete**. Sonarr and Radarr
also get a **Webhook** button.

A read-only JSON summary of every service's health is served, without
login, at `/api/status/` — for embedding in a homelab dashboard.

## Sonarr/Radarr webhooks

**Push instead of poll**: a Sonarr or Radarr instance can push its own
health changes to Cortexarr instead of Cortexarr only finding out at the
next poll. **Services → (the instance) → Webhook → Turn on webhooks** shows
the URL to paste into that instance's own **Settings → Connect → add a
Webhook** (method `POST`), with **Health Issue**, **Health Restored**, and
the on-add **Test** ticked.

- The URL carries a random per-service token — nothing else authenticates
  it, since Sonarr/Radarr's webhook connection can't reliably be made to
  send a custom header across every version. **Regenerate URL** rolls a new
  one; the old URL stops being accepted the moment the new one is issued,
  same as reissuing an API token.
- This never replaces polling. Sonarr/Radarr has no webhook event for "an
  item has been sitting in the queue too long" — only asking the queue
  periodically can find that — so the background poll keeps checking every
  service, webhook-enabled or not. A webhook just means the health half of
  a check doesn't have to wait for the next tick: Sonarr/Radarr tells
  Cortexarr the moment something changes, and it's alerted on immediately,
  the same way a poll result would be.
- **Turn off webhooks** goes back to polling only; the URL still exists but
  Sonarr/Radarr won't be sending it anything once you remove the connection
  there too.

## Maintenance mode

Toggling **Maintenance mode** on a service pauses health checks and drops
it out of the overall status on the public status endpoint, without
deleting its configuration. Use this when you know a service is down for a
planned reason and don't want alerts about it.

## Notifications

Under **Settings → Notifications**, each channel (email, webhook, ntfy,
SMS) is configured and enabled independently, with a **Send test** button
to confirm it actually works before relying on it.

**Settings → General → Time zone** sets the zone every time in Cortexarr is
shown in — tables, calendars (which day an episode lands on), and the
timestamp at the foot of each alert. Left on *Browser default*, each viewer
sees their own local time and alert messages are stamped in UTC.

### Alert rules

Nothing is sent until you add a rule: top nav → **Notifications** →
**Alerts** → **New rule**. A rule is:

- **When** — one of:
  - *Service unreachable* — can't connect, or the key/login is rejected.
  - *Service reports an error* / *a warning* — the service's own health
    check (an indexer down, a news server failing, …).
  - *Queue item stuck* — a Sonarr/Radarr download or import in warning or
    failed (e.g. "not enough free space").
  - *Download failed* — NZBGet/SABnzbd.
  - *Request failed or issue reported* — Seerr.
  - *Request waiting for approval* / *not in Sonarr/Radarr* / *still
    searching* / *still downloading* / *stuck importing* — a Seerr request
    that has sat in that stage of the pipeline (see Tracking in the User
    Guide). One rule per stage you care about gives each stage its own
    threshold, measured from when the request really entered it. Fixes
    offered: **Approve** while waiting for approval, **Search now** while
    searching.
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
- **Search now** — while a request is searching, ask Sonarr/Radarr to look
  again now rather than wait for its own schedule.
- **Clear** — deletes a Seerr request outright, whatever its status. For a
  request stalled at any stage that you don't want any more — the title
  was deleted, say, so Seerr never learns to stop tracking it. Offered on
  every "Request …" stalled problem and on a request Seerr failed to send.
  Asks you to type `Delete` first; there's no undo but the requester can
  always ask again.
- **Test connection** — for an unreachable service; says whether it's the
  network or the key.

A link opens the right page in the app itself (its queue, or System →
Status for health warnings). A fixed problem clears at the service's next
check.

**Many at once:** tick problems to fix or snooze them together. Only
problems with exactly the same fixes can be selected together — once one is
ticked, the others grey out — so one action means the same thing for every
one. **Select all that fix the same way** picks a whole group in one click
(e.g. every "Import it" problem) and hides everything else, so it's just
that group to review; click the same pill again, or **Show all**, to bring
the rest back. Several stuck episodes from one download (a season pack)
are handled once, and each problem shows how its fix went.

### Digests

**Settings → Notifications → Alert digest window** limits each channel
to one message every so many minutes. The first alert after a quiet spell still
goes out straight away; anything that fires within the window after it
waits and goes out together as one digest when the window ends. **0** (the
default) sends every alert as it happens. A rule's **Send test** is never
held back. On the Alerts tab, held alerts show as *queued* and each digest
is listed when it's sent; a digest that fails to send is retried at the
next window.

### Snooze and acknowledge

Each current problem on the Alerts tab has **Snooze**: silence it for an
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

**Settings → Users** (admins only — the tab doesn't show for anyone else)
lists every user, with their role, when they were created, and when they
last signed in.

- **New user** — username, email, password, and role.
- The **role** dropdown on each row changes it immediately.
- **Deactivate** / **Reactivate** — a deactivated user can't sign in, but
  stays on the list; nothing about them is deleted.
- **Reset password** — sets a new one directly, no current password
  needed, for someone who's forgotten theirs.
- **Delete** — removes the user outright, along with their API tokens and
  notification preferences (their name stays on past audit log entries).
  Asks you to type `Delete` first.

Cortexarr always keeps at least one active admin: demoting, deactivating,
or deleting the last one is refused, so the instance can never end up with
nobody able to manage it.

## Backup

**Settings → General → Backup** exports the service list and notification
configuration — not the SQLite database, and not users, health history, or
the alert/audit log — as a single JSON file, so a setup can be backed up or
moved to a fresh install.

- API keys and channel secrets (SMTP password, ntfy/webhook auth, Twilio
  auth token) are left out by default. Ticking **Include API keys and
  channel secrets** requires a password: the file comes back as a
  password-encrypted envelope (PBKDF2-HMAC-SHA256 deriving a Fernet key —
  the same encryption used for credentials at rest), never plain JSON with
  secrets sitting in it. Encryption is also available, same mechanism, for
  a credentials-free export.
- Cortexarr never stores the password — losing it means the file can't be
  read back. Importing an encrypted file asks for it again.
- **Import** reuses the same checks the web UI uses to add a service or a
  rule — a bad type, a duplicate name, or a rule pointing at a service the
  file doesn't also include is reported, not silently dropped.
- A service or alert rule whose name already exists here is left alone, not
  duplicated — importing the same file twice is safe. Notification settings
  are always applied, except a blank secret from a credentials-excluded file
  never overwrites a real one already configured.

## Self-update

**Settings → General** shows the running version and checks
`github.com/bsnwgit/cortexarr`'s releases once an hour for a newer one —
**Check now** asks immediately instead of waiting.

- **Manual** (the default) never updates on its own: a banner links to the
  release notes, and nothing on disk changes until an admin clicks
  **Update now** under it. That downloads the newest release, applies it
  exactly as Auto does (below) — at once, not waiting for the window — and
  restarts Cortexarr; the page reloads itself when the new version is up. It
  re-checks GitHub first, and it refuses on the same installs Auto does (a
  git checkout, the Docker image), saying why. It relies on the systemd
  unit's `Restart=always` to bring the new version back up; without a
  service manager the process exits and has to be started again by hand.
- **Auto** downloads the newer release's packaged asset and applies it
  itself, inside the daily window set below the mode dropdown — never
  outside it, so an update never lands mid-use. Applying means: replacing
  `app/`, `migrations/`, `docs/`, `VERSION`, `requirements.txt` and the
  built frontend in the install directory, `pip install`-ing any new
  Python dependencies into the existing virtualenv, then exiting — the
  systemd unit (`Restart=always`) brings the new version straight back up.
  `config.yaml`, the database, logs and the virtualenv itself are never
  touched by the swap.
- There's no code signing upstream: an auto-update trusts GitHub's TLS and
  nothing beyond it, the same as any other HTTPS download.
- Auto mode refuses to run against an install that's a git checkout (a
  `.git` directory next to `app/`) — that's a working tree, and overwriting
  it would silently discard whatever hasn't been committed. Development
  and staging checkouts should stay on manual and update via `git pull`
  instead.
- Auto mode also refuses inside the Docker image — there, `app/` lives in
  the read-only image layer, not somewhere a file swap could durably land.
  Update a container by pulling a new image tag instead (see the README's
  Docker section); self-update inside Docker only ever notifies.

## MCP server and API tokens

Cortexarr serves MCP (streamable HTTP) at `/mcp`, on the same port as the
web UI. Every tool is a web-UI action, run through the same code with the
same checks, so there's nothing an AI tool can do that its token's owner
couldn't do by hand. How users make tokens is in the
[User Guide](USER_GUIDE.md#api-tokens-and-ai-tools).

- An admin's **API tokens** page lists every user's tokens and can revoke
  any of them — a leaked token has to be stoppable by someone other than
  its owner.
- **Reissue** rolls a new secret onto an existing token — same name,
  access, and expiry — without reconfiguring anything else about it; the
  old secret stops working the moment the new one is issued. Prefer this
  over revoke-and-recreate when a token just needs rotating, not removing.
- Only admins can make write tokens, or tokens that allow destructive tools.
- Only a hash of each token is stored; a lost token is reissued or
  revoked and remade, not recovered.
- Requests from a web page on another site (a foreign `Origin` header) are
  refused.
- If Cortexarr sits behind a reverse proxy, forward `/mcp` as well as `/`
  and `/api`.
- Some MCP clients refuse a plain-HTTP endpoint. **Settings → General →
  Server (HTTPS)** lets you upload your own certificate and private key
  (PEM) and turn HTTPS on — for the whole app, not just `/mcp`, since they
  all share one listener. Turning it on or off, or replacing the
  certificate, only takes effect after the service is restarted.

## Audit log

Every change made in Cortexarr — services added or changed, monitor
toggles, searches, deletes, approvals, retries, pauses, settings — is
recorded under **Notifications → Audit Log** with who did it and when.
