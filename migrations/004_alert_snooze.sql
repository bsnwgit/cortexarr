-- Snooze / acknowledge (scope #9): silence one known problem without muting
-- the whole rule or service. Plus reminders, which are what a snooze holds off.

-- Remind every N minutes while the problem lasts; 0 = alert once only.
ALTER TABLE alert_rules ADD COLUMN repeat_minutes INTEGER NOT NULL DEFAULT 0;

-- One snooze per current problem. until = NULL means acknowledged: silent
-- until the problem clears. The row goes when the problem clears, so the
-- same key coming back later is a new problem, not a snoozed one.
CREATE TABLE IF NOT EXISTS alert_snoozes (
    service_instance_id INTEGER NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    key                 TEXT NOT NULL,
    until               TEXT,
    note                TEXT NOT NULL DEFAULT '',
    user_id             INTEGER,
    username            TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (service_instance_id, key)
);
