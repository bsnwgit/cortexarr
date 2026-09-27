-- End-to-end request tracking (scope #2): a Seerr request sitting in one
-- stage too long becomes an alert event per stage, so each stage's stall
-- threshold is just a rule's "for at least" — user-set, per stage.
--
-- alert_rules' event CHECK gains the five stalled_* events. SQLite can't
-- alter a CHECK, so the table is rebuilt; foreign keys are off while it is,
-- or dropping the old table would cascade-delete alert_notified's rows.
PRAGMA foreign_keys = OFF;

CREATE TABLE alert_rules_new (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    enabled            INTEGER NOT NULL DEFAULT 1,
    event              TEXT NOT NULL CHECK (event IN (
                           'unreachable', 'error', 'warning',
                           'stuck', 'download_failed', 'request_issue',
                           'stalled_approval', 'stalled_sending', 'stalled_searching',
                           'stalled_downloading', 'stalled_importing'
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

PRAGMA foreign_keys = ON;
