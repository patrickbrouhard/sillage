CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    permission TEXT NOT NULL CHECK (permission = 'mcp:read'),
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
);
