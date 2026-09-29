# Contributing to Cortexarr

Bug reports and feature requests are welcome — open an [issue](https://github.com/bsnwgit/cortexarr/issues).
For questions about setting something up, or general discussion, use
[Discussions](https://github.com/bsnwgit/cortexarr/discussions) instead — issues are for
concrete bugs and requests.

## Reporting a bug

Include: what you did, what you expected, what happened instead, and — if it's a service
integration issue — which service and version (Sonarr/Radarr/Seerr/NZBGet/SABnzbd). Logs
(`logs/cortexarr.log` on a native install, `docker compose logs` for Docker) help a lot.

Never paste API keys, passwords, or your `config.yaml` contents into an issue.

## Pull requests

- Branch off `main` as `feature/*` or `fix/*`.
- Match the existing code's style — see the shared backend/frontend structure described in the
  [README](README.md) and the two guides in `docs/`.
- A change to user-facing behavior should update `docs/ADMIN_GUIDE.md` or `docs/USER_GUIDE.md`
  in the same PR, not as a follow-up.
- `main` requires a pull request — there's no direct push, even for maintainers.

## Development setup

See the README's [Install](README.md#install) section for getting a running instance; for local
frontend development, `cd frontend && npm install && npm run dev` proxies `/api` to a backend
running separately on its configured port.
