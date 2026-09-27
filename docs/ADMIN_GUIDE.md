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

The **Services** page lists every service with **Test** (re-run the
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
confirm it actually works before relying on it. Notification *rules* —
which problems alert, at what threshold — aren't built yet (see *Requested
features* in the README); the channels themselves are live.

## Users and roles

- **admin** — everything: add and manage services, settings, users, and
  every action on a service (monitor, search, delete, approve/decline,
  retry, pause/resume).
- **analyst** / **viewer** — can see every page, but can't change anything.
  (The analyst role is reserved for future operational actions; today it
  has the same access as viewer.)

Manage users via `/api/users` (a dedicated admin page is planned).

## Audit log

Every change made in Cortexarr — services added or changed, monitor
toggles, searches, deletes, approvals, retries, pauses, settings — is
recorded under **Logs → Audit Log** with who did it and when.
