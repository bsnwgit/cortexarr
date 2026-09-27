# Cortexarr — User Guide

## Your account

Click your username in the top-right corner to open Settings, change your
password, or log out.

## Dashboard

The Dashboard shows one card per monitored service with its current health
and what it's doing right now: each item in its download queue gets its own
card inside the service card, with links straight to that item's page and
to the queue. A service reads one of:

- **Healthy** — reachable, no issues reported.
- **Warning** / **Error** — reachable, but the service itself reported a
  problem (e.g. an indexer error in Sonarr).
- **Unreachable** — Cortexarr couldn't reach it at all, or the API key was
  rejected. This is different from the service reporting its own problem,
  and means checking the URL/key rather than the service's own health page.
- **Maintenance** — checks are paused; excluded from the overall status.

## Service pages

Click a service to open its page.

**Sonarr** — *Series* (your library; open a series for its seasons and
episodes, with monitor, search, history, and delete), *Downloading* (queue
and history), *Missing* (aired episodes with no file, grouped by series),
and *Calendar* (a month grid of upcoming and missing episodes).

**Radarr** — *Movies* (your library, filterable by monitored, downloaded,
missing, released, or not yet released; open a movie for its details, file,
release dates, and monitor/search/history/delete), *Downloading* (queue and
history), *Missing* (released movies with no file), and *Calendar* (a month
grid of release dates — in cinemas, digital, physical). An upcoming release
date on a movie's page links to that month on the Calendar.

Deleting a series, movie, or file asks you to type `Delete` to confirm.
Removing a series or movie from Sonarr/Radarr does not delete its files
from disk.

## Notification preferences

Per-user notification preferences (which channels *you* personally receive
alerts through, independent of the instance-wide rules an admin configures)
are supported by the API but don't have a dedicated settings page in the
UI yet.
