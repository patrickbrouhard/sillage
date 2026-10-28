-- L'identité est unique ; les connaissances restent dans la bibliothèque existante.
CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL DEFAULT 1 REFERENCES owner(id),
    owner_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
