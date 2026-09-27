-- Personal API tokens for the MCP endpoint (scope #6b).
-- Only a SHA-256 hash of each token is stored; the token itself is shown
-- once, when it's made. A token acts as its owner, narrowed by `access`
-- ('read' offers only tools that change nothing) and `allow_destructive`
-- (deletes are refused unless the token was explicitly allowed them).

CREATE TABLE IF NOT EXISTS api_tokens (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    token_hash         TEXT NOT NULL UNIQUE,
    prefix             TEXT NOT NULL,          -- first few characters, to tell tokens apart
    access             TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write')),
    allow_destructive  INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at         TEXT,                   -- NULL = never expires
    last_used_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);
