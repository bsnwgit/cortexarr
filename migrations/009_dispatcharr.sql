-- Dispatcharr (live TV) becomes a monitored service type.
--
-- service_instances.type is a CHECK list, and SQLite can't alter a CHECK, so
-- the table is rebuilt with the new value. Foreign keys are off while it is,
-- or dropping the old table would cascade-delete every row that references
-- it (health snapshots, alert rules, snoozes, history).
PRAGMA foreign_keys = OFF;

CREATE TABLE service_instances_new (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    name                    TEXT NOT NULL,
    type                    TEXT NOT NULL CHECK (type IN ('sonarr', 'radarr', 'seerr', 'nzbget', 'sabnzbd', 'dispatcharr')),
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

PRAGMA foreign_keys = ON;
