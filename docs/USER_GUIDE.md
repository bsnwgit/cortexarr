# Cortexarr — User Guide

## Your account

Click your username in the top-right corner for **Services** (the list of
monitored services), **Alerts** (current problems, the alert rules, and
what's been sent — see the [Admin Guide](ADMIN_GUIDE.md#alert-rules)),
**Settings**, **API tokens**, **Change password**, and **Log out**.
Admins also see **Add service** under Services (see the
[Admin Guide](ADMIN_GUIDE.md)).

## Dashboard

![Dashboard](images/dashboard.png)

**Seerr** runs full width across the top: a strip of recent request
posters, with anything failed, waiting for approval, or processing first.
The counts across the middle (pending approval, processing, failed, issues) each
open that list.

Below it, each service has a card with its health and what needs attention
right now:

- **Sonarr** — a card per episode that's stuck or downloading, then a card
  per series with missing episodes. Click a card to open the series; the
  pills open the queue (filtered to that series) or the series at its first
  missing season.
- **Radarr** — a card per movie that's stuck, downloading, or missing.
  Click a card to open the movie; the pills open the queue (filtered to
  that movie) or the missing list.
- **NZBGet / SABnzbd** — speed, time left, and free disk, then a card per
  download with its progress, and any download that failed in the last day
  with the reason.

Every service shows one of:

- **Healthy** — reachable, no issues reported.
- **Warning** / **Error** — reachable, but the service itself reported a
  problem (e.g. an indexer error in Sonarr, a news-server login failing in
  SABnzbd).
- **Unreachable** — Cortexarr couldn't reach it, or the key/login was
  rejected. Check the URL and key rather than the service's own health.
- **Maintenance** — checks are paused; excluded from the overall status.

Beside the status, the refresh icon reloads just that card now rather than
waiting for its next update, and the arrow icon opens the service's own web
UI in a new tab. Click anywhere else on a card to open that service's page.

## Service pages

The refresh icon at the right of a service page's header reloads that page
— the overview strip and the tab you're on.

Tables can be searched, sorted by clicking a column header, and paged;
the series and movie libraries can be searched, filtered, and paged.
Deleting a series, movie, file, or download asks you to type `Delete` to
confirm.

### Sonarr

![Series library](images/series-library.png)

- **Series** — your library, filterable by monitored / unmonitored /
  continuing / ended. Open a series for its seasons (newest first, Specials
  last): monitor a whole series or season, search a season, see its
  history, and open a season for its episodes — each with its own monitor
  toggle, a search button when it's missing, or delete-file when it's
  there. An *Upcoming* episode opens the series calendar at its month.
- **Downloading** — the queue (with why an item is stuck, if it is) and
  recent history.
- **Missing** — aired episodes with no file, grouped by series; each links
  to its season.
- **Calendar** — a month grid of upcoming and missing episodes; click one
  to jump to its series and season.

![Series page](images/series-detail.png)

Removing a series from Sonarr does not delete its files from disk.

### Radarr

![Movie page](images/movie-detail.png)

- **Movies** — your library, filterable by monitored, downloaded, missing,
  released, or not yet released. Open a movie for its details, the file on
  disk (with delete-file), its release dates, and monitor / search /
  history / delete. An upcoming release date links to that month on the
  calendar.
- **Downloading** — the queue and recent history.
- **Missing** — released movies with no file, with search and a monitor
  toggle on each.
- **Calendar** — a month grid of release dates (in cinemas, digital,
  physical).

Removing a movie from Radarr does not delete its files from disk.

![Calendar](images/calendar.png)

### Seerr

![Seerr requests](images/seerr-requests.png)

- **Requests** — recent requests: title, movie or TV (with seasons), who
  asked, when, and status. A request still pending approval has
  **Approve** / **Decline**; a failed one has **Retry**, which sends it to
  Sonarr/Radarr again.
- **Issues** — requests that failed to reach Sonarr/Radarr, with the reason
  from Seerr's log when it still has it, and **Retry** — plus problems users
  reported against a title (bad video, missing audio, wrong subtitles).

![Seerr issues](images/seerr-issues.png)

### NZBGet / SABnzbd

![Download queue](images/downloads-queue.png)

A status bar across the top shows current speed, what's left (with an
estimated time), free disk space, anything post-processing, and **Pause all
/ Resume all**.

- **Queue** — downloads in the client's own order with progress, time
  left, and (NZBGet only) health, followed by anything still post-processing
  (verifying, repairing, unpacking). A download can be paused, resumed,
  moved to the top, or deleted — NZBGet moves a deleted download to its
  history; SABnzbd removes it but keeps any files already downloaded.
- **History** — each finished download's result, filterable by result.
  Failed ones show why (NZBGet: from that download's own log; SABnzbd: its
  failure message) and can be **retried**.

![Download history](images/downloads-history.png)

## Logs

![Activity log](images/activity-log.png)

- **Activities** — one feed across every service: what Sonarr and Radarr
  grabbed and imported, request changes in Seerr, and finished downloads.
  The dropdown narrows it to one pipeline (Series, Movies, Requests,
  Downloads — only the ones you've added appear).
- **Audit Log** — every change made in Cortexarr, who made it, and when:
  services added or changed, monitor toggles, searches, deletes, approvals.

## Notification preferences

Per-user notification preferences (which channels *you* personally receive
alerts through, independent of the instance-wide settings an admin
configures) are supported by the API but don't have a settings page in the
UI yet.

## API tokens and AI tools

Cortexarr is an MCP server: an AI tool that speaks MCP can check your
pipeline's health, look through queues, libraries, requests and history,
and — with the right token — act on them, the same as you can in the web UI.

User menu → **API tokens** → **New token**. Give it a name you'll recognise
and an expiry, then copy the token straight away — it's shown only once.
The page also gives a ready-made client config: the server URL is
`http(s)://<your Cortexarr>/mcp`, and the token goes in an
`Authorization: Bearer <token>` header.

- **Read** tokens can only look. Anyone can make one.
- **Write** tokens can also change things — monitor, search, approve,
  pause, change settings. Admins only, because every write is admin-only.
- **Allow destructive tools** (admins, write tokens only) adds deleting
  services, series, movies, files, and downloads. The AI tool won't ask
  before it does, so leave this off unless you need it.

A token acts as you: anything it changes shows in the audit log as
`<you> (MCP: <token name>)`. **Revoke** stops a token immediately. A token
can't change your password or make other tokens.

