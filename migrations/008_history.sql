-- History and trends: request completions over time. Uptime and alert
-- trends are aggregated straight from the existing health_snapshots and
-- alert_log tables (see app/api/history.py) — this is the one thing
-- nothing already persists, because tracking.py computes each request's
-- stage live and doesn't remember when a request crossed into 'available'.
--
-- app/history.py's periodic scan records a row the first time it sees a
-- request reach 'available' that isn't here yet — available_at is when
-- Cortexarr noticed, not the exact moment Sonarr/Radarr finished
-- importing, so it's accurate to the scan interval, not to the second.
-- Nothing is backfilled for requests that were already available before
-- this table existed.
CREATE TABLE IF NOT EXISTS request_history (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    seerr_service_id    INTEGER NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    request_id          INTEGER NOT NULL,
    title               TEXT NOT NULL DEFAULT '',
    media_type          TEXT NOT NULL DEFAULT '',
    is_4k               INTEGER NOT NULL DEFAULT 0,
    requested_at        TEXT,
    available_at        TEXT NOT NULL DEFAULT (datetime('now')),
    duration_seconds    INTEGER,
    UNIQUE (seerr_service_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_request_history_available_at ON request_history (available_at DESC);
