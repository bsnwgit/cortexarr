<img src="docs/logo.svg" alt="" width="64" height="64" align="left" />

# Cortexarr

Health and flow monitoring for a self-hosted media acquisition pipeline —
Sonarr, Radarr, Seerr, and your Usenet download client (NZBGet, SABnzbd) —
in one dashboard, with configurable alerting and an MCP server for AI-agent
parity with the web UI.

Cortexarr surfaces each service's own health signals, tracks a request's
progress from Seerr through to import, and flags anything that stalls
along the way — instead of tabbing between four separate admin UIs to find
out something's broken.

Currently implemented: Sonarr and Radarr — health monitoring, library,
queue, missing, and calendar views, with monitor/search/delete actions —
plus connection testing, per-service polling with retry/backoff, role-based
auth (admin/analyst/viewer), audit logging, and notifications across email,
webhook (Slack/Discord), push (ntfy), and SMS (Twilio). Seerr,
download-client support, item-level flow tracking, and MCP/AI integration
are in progress.

## Requirements

- Ubuntu 22.04/24.04 LTS (or any Linux with Python 3.11+ and systemd)
- Python 3.11+
- Node.js (for building the frontend — any recent LTS)

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

## Configuration

Startup/infrastructure settings live in `config.yaml` (copy from
`config.example.yaml` if not using `install.sh`). Everything else —
monitored services, notification rules, retention, polling intervals — is
managed through the web UI and stored in SQLite.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE).
