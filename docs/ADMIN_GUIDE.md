# Cortexarr — Admin Guide

## Adding a monitored service

Under **Services → + Add service**, pick a type (only Sonarr is implemented
so far), give it a name, base URL, and API key, then **Test connection**
before saving — this checks the URL and key actually work.

Each service instance has its own poll interval and retry/backoff settings,
so a fast-changing instance can be checked more often than a slow one
without affecting the others.

## Maintenance mode

Toggling **Maintenance mode** on a service pauses health checks and drops
it out of the overall status on the public status endpoint, without
deleting its configuration. Use this when you know a service is down for a
planned reason and don't want alerts about it.

## Notifications

Under **Settings**, each channel (email, webhook, ntfy, SMS) is configured
and enabled independently, with a **Send test** button to confirm it
actually works before relying on it. Notification *rules* — which checks
alert, at what threshold — are on the roadmap; the channels themselves are
live.

## Users and roles

- **admin** — full access: manage services, settings, users.
- **analyst** — read/write on operational data, not user management.
- **viewer** — read-only.

Manage users via `/api/users` (a dedicated admin page is planned).

## Audit log

Every service and settings change is recorded under **Audit Log** — who
did what, and when.
