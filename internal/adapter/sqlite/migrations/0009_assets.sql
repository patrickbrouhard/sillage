CREATE TABLE assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    source_id INTEGER,
    timestamp_ms INTEGER CHECK (timestamp_ms >= 0),
    type TEXT NOT NULL CHECK (type = 'screenshot'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'available', 'failed')),
    path TEXT UNIQUE,
    size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
    error_code TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_id, video_id) REFERENCES video_sources(id, video_id),
    CHECK (type != 'screenshot' OR (source_id IS NOT NULL AND timestamp_ms IS NOT NULL)),
    CHECK (path IS NULL OR length(path) > 0),
    CHECK (status != 'available' OR (path IS NOT NULL AND size > 0))
);
CREATE INDEX ix_assets_video ON assets(video_id);
