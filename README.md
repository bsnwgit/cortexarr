<img src="docs/logo.svg" alt="" width="64" height="64" align="left" />

# Cortexarr

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)
[![GitHub Discussions](https://img.shields.io/github/discussions/bsnwgit/cortexarr)](https://github.com/bsnwgit/cortexarr/discussions)

One dashboard for a self-hosted media acquisition pipeline — Seerr,
Sonarr, Radarr, and your Usenet download client (NZBGet or SABnzbd) —
instead of tabbing between five admin UIs to find out what's stuck.

Cortexarr shows each service's own health, what's downloading and what's
missing right now, and why things failed, and lets you act on it (approve a
request, retry a failed download, search for a missing episode) without
leaving the page.

![Dashboard](docs/images/dashboard.png)

## What it does

- **Seerr** — requests with who asked for what, and **Approve / Decline**
  for anything still pending. An *Issues* list pairs user-reported problems
  with requests that failed to reach Sonarr/Radarr, including *why* they
  failed (pulled from Seerr's log), with **Retry**.
- **Sonarr** — your series library, each series with its seasons and
  episodes (monitor, search, delete), the download queue, missing episodes
  grouped by series, and a month-grid calendar. The library filters by
  monitored state, continuing/ended, or missing episodes — filter to
  missing, select the ones you want, and search all of them at once.
  Deleting a series offers
  removing its matching Seerr request too, so Seerr doesn't keep thinking
  it's wanted and quietly try to fill it again. Can also accept its own
  webhook (Settings → Services → Webhook) so a health change reaches
  Cortexarr the moment it happens rather than waiting for the next poll —
  polling itself never stops, since there's no webhook for "an item's been
  stuck in the queue a while."
- **Radarr** — the same for movies: library, movie pages with release
  dates and the file on disk, queue, missing, and a release calendar. Same
  coordinated delete, same optional webhook.
- **NZBGet / SABnzbd** — live speed, time left, free disk, the queue with
  progress and post-processing stage, and history with failure reasons and
  **Retry**. Pause/resume a download or everything at once.
- **Request tracking** — every Seerr request followed through approval,
  Sonarr/Radarr, searching, downloading and import to available, with how
  long it's been in its stage (and episode counts for TV); alert rules flag
  a request that stalls in a stage longer than you set. Flags it too when
  Seerr's own status has gone stale — it says available, but Sonarr/Radarr
  is still searching — with a one-click **Search again**.
- **Dashboard** — requests run full width across the top; below, one card
  per service with nested cards for whatever needs attention. Each card can
  be refreshed on its own or opened in the service's own web UI.
- **History** — a top-nav tab with reporting over time: per-service uptime
  (from health checks already being recorded), alert frequency with the
  most active rules and services, and requests completed with average time
  to available. A 7/30/90-day range on each. Request trends fill in going
  forward from when this shipped — nothing before that is backfilled.
- **Notifications** — a top-nav tab, next to Tracking, with four views:
  Alerts and Rules (below), an activity feed across every service
  (filterable by pipeline), and an audit log of every change made in
  Cortexarr.
- **MCP server** — AI tools (any MCP client) can do everything the web UI
  does, through personal API tokens that are read-only by default and never
  delete anything unless you allow it. Upload your own certificate under
  Settings → Server to serve everything — the web UI, the API, and `/mcp` —
  over HTTPS, for clients that refuse a plain-HTTP endpoint.
- Per-service health polling with retry/backoff, a connection test that
  also checks the URL really is the service you picked, role-based access
  (admin / analyst / viewer) with a **Users** page to manage them, and
  notifications over email, Slack/Discord webhooks, ntfy push, and Twilio
  SMS.
- **Alerts** — your own rules for what notifies: a service unreachable or
  reporting an error, a queue item stuck, a download failed, a request
  failed or an issue reported — on which services, after how long, through
  which channels, with an optional "resolved" message when it clears and
  reminders while it lasts. Snooze or acknowledge a known problem without
  muting the whole rule, and set a digest window so a bad night is one
  message every so often, not dozens. Suggested starter rules (a service
  unreachable, a queue item stuck, a request stalled) are offered as
  one-click templates while the rule list is empty.
- **Backup** — export the service list and notification configuration (not
  the database) to move a setup or back it up, credentials excluded unless
  you choose to include them — which requires a password and encrypts the
  file, rather than writing secrets out in plain text. Re-importing skips
  anything already there by name, so it's safe to run the same file twice.
- **Self-update** — checks GitHub releases against the running version;
  manual mode (the default) just shows what's available, auto mode
  downloads and applies it inside a maintenance window you set, then
  restarts itself.

## Requested features

Planned but not built yet — kept here so none of it gets lost:

- **Force sync with reality, the rest of it** — Tracking already flags one
  mismatch (Seerr says available, Sonarr/Radarr is still searching); still
  open is the download client and disk itself, and orphaned Seerr requests
  with nothing left in Sonarr/Radarr to match them to.
- **AI provider integration** — pluggable AI providers inside Cortexarr
  itself (the MCP server for outside AI tools is built).
- **Live TV (Dispatcharr)** — its own dashboard section.

## Screenshots

| | |
|---|---|
| ![Series library](docs/images/series-library.png) | ![Series page](docs/images/series-detail.png) |
| **Sonarr** — series library | **Sonarr** — a series, its seasons and episodes |
| ![Movie page](docs/images/movie-detail.png) | ![Calendar](docs/images/calendar.png) |
| **Radarr** — a movie, with its release dates | **Calendar** — a month at a time |
| ![Seerr requests](docs/images/seerr-requests.png) | ![Seerr issues](docs/images/seerr-issues.png) |
| **Seerr** — requests, approve/decline | **Seerr** — issues, with why a request failed |
| ![Download queue](docs/images/downloads-queue.png) | ![Download history](docs/images/downloads-history.png) |
| **NZBGet / SABnzbd** — queue | **NZBGet / SABnzbd** — history and failure reasons |

![Activity log](docs/images/activity-log.png)

*Screenshots use a made-up demo library.*

## Requirements

Native install:
- Ubuntu 22.04/24.04 LTS (or any Linux with Python 3.11+ and systemd)
- Python 3.11+
- Node.js (for building the frontend — any recent LTS)

Docker: just Docker and Compose — the image builds the frontend itself.

Either way: any of Sonarr, Radarr, Seerr, NZBGet, or SABnzbd — add only
what you run.

## Install

Get the code first, either way:

```
git clone https://github.com/bsnwgit/cortexarr.git
cd cortexarr
```

Then, native (Ubuntu, systemd):

```
bash install.sh
```

Prompts for an install directory (default `/opt/cortexarr`) and port
(default `8770`), then sets up a virtualenv, database, systemd service, and
builds the frontend. Prints the generated admin password once at the end —
save it.

To remove: `bash uninstall.sh` (keeps your data by default; `--purge` to
remove that too).

Or Docker:

```
docker compose up -d --build
docker compose logs -f
```

Watch the logs for the "Cortexarr admin account created" block — the
generated username and password are printed there once, on first boot
only, and won't be shown again. `Ctrl+C` once you've got it, then open
`http://<this-host>:8770` and sign in.

Everything persistent — `config.yaml`, the database, logs — lives in the
`cortexarr-data` volume; the image itself holds only code, so upgrading is
`docker compose pull && docker compose up -d`, not self-update's in-place
apply (self-update inside Docker only ever notifies — see the Admin Guide).

## Getting started

1. Open Cortexarr in a browser and sign in as `admin` with the password the
   installer printed. Change it from the user menu (your username, top
   right).
2. From the same menu, open **Settings → Services** and choose **New
   service**. Pick the type, enter its URL and API key (NZBGet asks for
   its username and password instead), and **Test connection** before
   saving.
3. Repeat for each service you run. The Dashboard fills in as they're
   checked. **Settings → Services** lists them, with test, maintenance
   mode, and delete.

The [User Guide](docs/USER_GUIDE.md) walks through each page; the
[Admin Guide](docs/ADMIN_GUIDE.md) covers adding services, maintenance
mode, notifications, and users.

## Configuration

Startup/infrastructure settings live in `config.yaml` (copy from
`config.example.yaml` if not using `install.sh`). Everything else —
monitored services, notification channels, retention, polling intervals —
is managed through the web UI and stored in SQLite. Service API keys and
passwords are encrypted at rest.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE).
