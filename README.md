<img src="docs/logo.svg" alt="" width="64" height="64" align="left" />

# Cortexarr

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
  grouped by series, and a month-grid calendar.
- **Radarr** — the same for movies: library, movie pages with release
  dates and the file on disk, queue, missing, and a release calendar.
- **NZBGet / SABnzbd** — live speed, time left, free disk, the queue with
  progress and post-processing stage, and history with failure reasons and
  **Retry**. Pause/resume a download or everything at once.
- **Request tracking** — every Seerr request followed through approval,
  Sonarr/Radarr, searching, downloading and import to available, with how
  long it's been in its stage (and episode counts for TV); alert rules flag
  a request that stalls in a stage longer than you set.
- **Dashboard** — requests run full width across the top; below, one card
  per service with nested cards for whatever needs attention. Each card can
  be refreshed on its own or opened in the service's own web UI.
- **Notifications** — a top-nav tab, next to Tracking, with three views:
  Alerts (below), an activity feed across every service (filterable by
  pipeline), and an audit log of every change made in Cortexarr.
- **MCP server** — AI tools (any MCP client) can do everything the web UI
  does, through personal API tokens that are read-only by default and never
  delete anything unless you allow it.
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
  message every so often, not dozens.

## Requested features

Planned but not built yet — kept here so none of it gets lost:

- **Mass filtering at series level** — filter the series library by state
  (e.g. series with missing episodes) and select the matching series to act
  on together.
- **Suggested alert rules** — a starter set of common alerts (a service
  unreachable, a queue item stuck, a request stalled) offered as one-click
  templates when no rules exist yet, so it's obvious what's worth alerting
  on instead of finding out nothing fires until you add one yourself.
- **Force sync with reality** — compare what Seerr says (requested,
  processing, available) with what's really in Sonarr/Radarr, the download
  client, and on disk; show every mismatch, and bring them back in line in
  one step.
- **Push instead of poll** — accept Sonarr/Radarr webhooks rather than only
  polling them.
- **History and trends** — reporting over time, beyond the live views.
- **AI provider integration** — pluggable AI providers inside Cortexarr
  itself (the MCP server for outside AI tools is built).
- **Config export / import** — back up or move the service list and
  settings (credentials excluded unless you choose to include them).
- **Self-update** — manual or automatic updates from GitHub releases, within
  a maintenance window you set.
- **Docker install** — alongside the native `install.sh`.
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

- Ubuntu 22.04/24.04 LTS (or any Linux with Python 3.11+ and systemd)
- Python 3.11+
- Node.js (for building the frontend — any recent LTS)
- Any of Sonarr, Radarr, Seerr, NZBGet, or SABnzbd — add only what you
  run.

## Install

```
bash install.sh
```

Prompts for an install directory (default `/opt/cortexarr`) and port
(default `8770`), then sets up a virtualenv, database, systemd service, and
builds the frontend. Prints the generated admin password once at the end —
save it.

To remove: `bash uninstall.sh` (keeps your data by default; `--purge` to
remove that too).

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
