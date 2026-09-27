-- Alerts on real events (scope #3): user-defined rules that turn problems
-- the poller sees into notifications. Nothing here is a Cortexarr-decided
-- default — no rule exists until a user makes one.

-- A rule: which event, on which service(s), how long it must persist, and
-- which channels it goes out through.
CREATE TABLE IF NOT EXISTS alert_rules (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    enabled            INTEGER NOT NULL DEFAULT 1,
    event              TEXT NOT NULL CHECK (event IN (
                           'unreachable', 'error', 'warning',      -- the service's own health
                           'stuck', 'download_failed', 'request_issue'  -- individual items
                       )),
    service_id         INTEGER REFERENCES service_instances(id) ON DELETE CASCADE,  -- NULL = every service
    threshold_minutes  INTEGER NOT NULL DEFAULT 0,    -- must persist this long first; 0 = at once
    channels           TEXT NOT NULL DEFAULT '[]',    -- JSON list: email / webhook / ntfy / sms
    notify_resolved    INTEGER NOT NULL DEFAULT 1,    -- also say when it clears (state events only)
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Problems currently seen, one row per (service, key) — e.g. 'health' or
-- 'stuck:1234'. first_seen is what thresholds are measured from; a row is
-- deleted when the problem is no longer there.
CREATE TABLE IF NOT EXISTS alert_conditions (
    service_instance_id INTEGER NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    key                 TEXT NOT NULL,
    event               TEXT NOT NULL,
    title               TEXT NOT NULL DEFAULT '',
    detail              TEXT NOT NULL DEFAULT '',
    first_seen          TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (service_instance_id, key)
);

-- Which rule has already alerted on which condition, so nothing repeats;
-- and so a "resolved" goes only to rules that said something in the first place.
CREATE TABLE IF NOT EXISTS alert_notified (
    rule_id             INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    service_instance_id INTEGER NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
    key                 TEXT NOT NULL,
    sent_at             TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (rule_id, service_instance_id, key)
);

-- When Cortexarr started watching each service for item events, so failures
-- that happened before it was watching don't all fire at once on first run.
CREATE TABLE IF NOT EXISTS alert_baselines (
    service_instance_id INTEGER PRIMARY KEY REFERENCES service_instances(id) ON DELETE CASCADE,
    started_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every alert sent (or that failed to send), for the Alerts page.
CREATE TABLE IF NOT EXISTS alert_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at             TEXT NOT NULL DEFAULT (datetime('now')),
    rule_id             INTEGER,
    rule_name           TEXT NOT NULL DEFAULT '',
    service_instance_id INTEGER,
    service_name        TEXT NOT NULL DEFAULT '',
    event               TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('alert', 'resolved', 'test')),
    subject             TEXT NOT NULL DEFAULT '',
    body                TEXT NOT NULL DEFAULT '',
    results             TEXT NOT NULL DEFAULT '{}'   -- JSON: channel -> {status, detail}
);

CREATE INDEX IF NOT EXISTS idx_alert_log_time ON alert_log (sent_at DESC);
