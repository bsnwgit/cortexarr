# Cortexarr — User Guide

## Your account

Click your username in the top-right corner to change your password or log
out.

## Dashboard

The Dashboard shows every monitored service and its current health at a
glance. A service reads one of:

- **Healthy** — reachable, no issues reported.
- **Warning** / **Error** — reachable, but the service itself reported a
  problem (e.g. an indexer error in Sonarr).
- **Unreachable** — Cortexarr couldn't reach it at all, or the API key was
  rejected. This is different from the service reporting its own problem,
  and means checking the URL/key rather than the service's own health page.
- **Maintenance** — checks are paused; excluded from the overall status.

Use the search box and type filter to narrow the list once you have more
than a few services.

## Notification preferences

Per-user notification preferences (which channels *you* personally receive
alerts through, independent of the instance-wide rules an admin configures)
are supported by the API but don't have a dedicated settings page in the
UI yet.
