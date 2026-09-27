-- Notification digests (scope #12): with a batching window set, alerts wait
-- in an outbox and go out as one message per channel, at most once per window.

CREATE TABLE IF NOT EXISTS alert_outbox (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    channel             TEXT NOT NULL,
    rule_name           TEXT NOT NULL DEFAULT '',
    service_name        TEXT NOT NULL DEFAULT '',
    subject             TEXT NOT NULL DEFAULT '',
    body                TEXT NOT NULL DEFAULT ''
);

-- When each channel last sent a digest — the window runs from there.
CREATE TABLE IF NOT EXISTS alert_digest_state (
    channel             TEXT PRIMARY KEY,
    last_sent_at        TEXT NOT NULL
);

-- alert_log gains a 'digest' kind. SQLite can't alter a CHECK constraint,
-- so the table is rebuilt with its rows carried over.
CREATE TABLE alert_log_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at             TEXT NOT NULL DEFAULT (datetime('now')),
    rule_id             INTEGER,
    rule_name           TEXT NOT NULL DEFAULT '',
    service_instance_id INTEGER,
    service_name        TEXT NOT NULL DEFAULT '',
    event               TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('alert', 'resolved', 'test', 'digest')),
    subject             TEXT NOT NULL DEFAULT '',
    body                TEXT NOT NULL DEFAULT '',
    results             TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO alert_log_new (id, sent_at, rule_id, rule_name, service_instance_id, service_name, event, kind, subject, body, results)
    SELECT id, sent_at, rule_id, rule_name, service_instance_id, service_name, event, kind, subject, body, results FROM alert_log;
DROP TABLE alert_log;
ALTER TABLE alert_log_new RENAME TO alert_log;
CREATE INDEX IF NOT EXISTS idx_alert_log_time ON alert_log (sent_at DESC);
