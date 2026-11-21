-- Duplicate-file detection. A "library" service is a machine Cortexarr reaches
-- over SSH to list the media folders (it is not an API like the others), and
-- 'duplicate' becomes an alert event.
--
-- service_instances.type and alert_rules.event are CHECK lists, and SQLite
-- can't alter a CHECK, so both tables are rebuilt. Foreign keys are off while
-- they are, or dropping the old table would cascade-delete every row that
-- references it (health snapshots, alert rules, snoozes, history).
--
-- A library keeps its SSH user, key path, port and folders as JSON in the same
-- (encrypted) field the other types keep their API key in, so every route that
-- reads a service's credential works for it unchanged. Nothing in it is a
-- secret — the key is a path on this host, never its contents — so the API
-- shows it as `config` rather than masking it.
PRAGMA foreign_keys = OFF;

CREATE TABLE service_instances_new (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    name                    TEXT NOT NULL,
    type                    TEXT NOT NULL CHECK (type IN ('sonarr', 'radarr', 'seerr', 'nzbget', 'sabnzbd', 'dispatcharr', 'library')),
    base_url                TEXT NOT NULL,
    api_key_enc             TEXT NOT NULL DEFAULT '',
    enabled                 INTEGER NOT NULL DEFAULT 1,
    maintenance_mode        INTEGER NOT NULL DEFAULT 0,
    ingestion_mode          TEXT NOT NULL DEFAULT 'poll' CHECK (ingestion_mode IN ('poll', 'webhook')),
    poll_interval_seconds   INTEGER NOT NULL DEFAULT 60,
    retry_count             INTEGER NOT NULL DEFAULT 3,
    retry_backoff_seconds   INTEGER NOT NULL DEFAULT 5,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    webhook_token           TEXT NOT NULL DEFAULT ''
);
INSERT INTO service_instances_new (id, name, type, base_url, api_key_enc, enabled, maintenance_mode,
                                   ingestion_mode, poll_interval_seconds, retry_count, retry_backoff_seconds,
                                   created_at, updated_at, webhook_token)
    SELECT id, name, type, base_url, api_key_enc, enabled, maintenance_mode,
           ingestion_mode, poll_interval_seconds, retry_count, retry_backoff_seconds,
           created_at, updated_at, webhook_token FROM service_instances;
DROP TABLE service_instances;
ALTER TABLE service_instances_new RENAME TO service_instances;

CREATE TABLE alert_rules_new (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    enabled            INTEGER NOT NULL DEFAULT 1,
    event              TEXT NOT NULL CHECK (event IN (
                           'unreachable', 'error', 'warning',
                           'stuck', 'download_failed', 'request_issue',
                           'stalled_approval', 'stalled_sending', 'stalled_searching',
                           'stalled_downloading', 'stalled_importing',
                           'duplicate'
                       )),
    service_id         INTEGER REFERENCES service_instances(id) ON DELETE CASCADE,
    threshold_minutes  INTEGER NOT NULL DEFAULT 0,
    channels           TEXT NOT NULL DEFAULT '[]',
    notify_resolved    INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    repeat_minutes     INTEGER NOT NULL DEFAULT 0
);
INSERT INTO alert_rules_new (id, name, enabled, event, service_id, threshold_minutes, channels, notify_resolved,
                             created_at, updated_at, repeat_minutes)
    SELECT id, name, enabled, event, service_id, threshold_minutes, channels, notify_resolved,
           created_at, updated_at, repeat_minutes FROM alert_rules;
DROP TABLE alert_rules;
ALTER TABLE alert_rules_new RENAME TO alert_rules;

-- What the last scan of each library found, one row per duplicate. The same
-- rows drive the alert (as alert_conditions) and the Duplicates panel; the
-- file list is kept here so a delete can only name a file the scan really saw.
CREATE TABLE IF NOT EXISTS duplicate_findings (
    service_instance_id INTEGER NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    key                 TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    title               TEXT NOT NULL,
    reason              TEXT NOT NULL,
    files               TEXT NOT NULL DEFAULT '[]',   -- JSON list of absolute paths
    first_seen          TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (service_instance_id, key)
);

-- When each library was last scanned, and how it went.
CREATE TABLE IF NOT EXISTS library_scans (
    service_instance_id INTEGER PRIMARY KEY REFERENCES service_instances(id) ON DELETE CASCADE,
    scanned_at          TEXT NOT NULL DEFAULT (datetime('now')),
    files_seen          INTEGER NOT NULL DEFAULT 0,
    seconds             REAL NOT NULL DEFAULT 0
);

PRAGMA foreign_keys = ON;
