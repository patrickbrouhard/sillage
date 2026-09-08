CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE video_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),

    provider TEXT NOT NULL,
    external_id TEXT,
    canonical_url TEXT,

    title TEXT NOT NULL,
    description TEXT,
    creator TEXT,
    duration_ms INTEGER,
    thumbnail_url TEXT,

    CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE UNIQUE INDEX ux_video_sources_provider_external_id
    ON video_sources(provider, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX ix_video_sources_video_id
    ON video_sources(video_id);
