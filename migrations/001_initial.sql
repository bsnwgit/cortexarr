-- Cortexarr initial schema.
-- Sonarr-only slice: users/auth, global + per-user notification config,
-- monitored service instances, health snapshots, audit log.
-- Item-level flow tracking tables land once a second/third service (Seerr,
-- a download client) exist to correlate against.

CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT NOT NULL UNIQUE,
    email             TEXT NOT NULL,
    hashed_password   TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'analyst', 'viewer')),
    is_active         INTEGER NOT NULL DEFAULT 1,
    is_default_admin  INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_login        TEXT
);

-- Global settings: shared instance-wide notification rules/thresholds,
-- retention, batching window, self-update mode, etc. Values are JSON-encoded.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user notification preferences — the second layer alongside global
-- settings (scope item #13): which channels a given user gets notified
-- through, and their address/target for each.
CREATE TABLE IF NOT EXISTS user_notification_prefs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL CHECK (channel IN ('email', 'webhook', 'ntfy', 'sms')),
    enabled     INTEGER NOT NULL DEFAULT 1,
    target      TEXT NOT NULL DEFAULT '',   -- email address / webhook URL / ntfy topic / phone number
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, channel)
);

-- Monitored services. `type` is the pluggable-integration discriminator —
-- 'sonarr' is the only type with a real client behind it in this slice;
-- 'radarr', 'seerr', 'nzbget', 'sabnzbd' land as their own clients get built,
-- reusing this same table rather than one table per service type.
CREATE TABLE IF NOT EXISTS service_instances (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    name                    TEXT NOT NULL,
    type                    TEXT NOT NULL CHECK (type IN ('sonarr', 'radarr', 'seerr', 'nzbget', 'sabnzbd')),
    base_url                TEXT NOT NULL,
    api_key_enc             TEXT NOT NULL DEFAULT '',
    enabled                 INTEGER NOT NULL DEFAULT 1,
    maintenance_mode        INTEGER NOT NULL DEFAULT 0,   -- scope #15: pause checks, don't alert
    ingestion_mode          TEXT NOT NULL DEFAULT 'poll' CHECK (ingestion_mode IN ('poll', 'webhook')),
    poll_interval_seconds   INTEGER NOT NULL DEFAULT 60,  -- scope #18: per-service, not global
    retry_count             INTEGER NOT NULL DEFAULT 3,   -- scope #17
    retry_backoff_seconds   INTEGER NOT NULL DEFAULT 5,   -- scope #17
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Health snapshots — app-level health (scope #1), one row per check.
-- connectivity_ok distinguishes "couldn't reach it / bad key" from "reached
-- fine, it reported its own problem" (scope #8) — collapsing those into one
-- status was the thing to specifically avoid.
CREATE TABLE IF NOT EXISTS health_snapshots (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    service_instance_id INTEGER NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
    connectivity_ok     INTEGER NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('ok', 'warning', 'error', 'unreachable')),
    detail              TEXT NOT NULL DEFAULT ''   -- JSON: raw health issues reported by the service, or the connectivity error
);

CREATE INDEX IF NOT EXISTS idx_health_snapshots_instance_time
    ON health_snapshots (service_instance_id, checked_at DESC);

-- Audit log (scope #21) — configuration changes only, not general request logging.
CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    username     TEXT NOT NULL,
    action       TEXT NOT NULL,          -- e.g. 'service.create', 'service.delete', 'setting.update'
    target_type  TEXT NOT NULL DEFAULT '',
    target_id    TEXT NOT NULL DEFAULT '',
    detail       TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log (created_at DESC);
