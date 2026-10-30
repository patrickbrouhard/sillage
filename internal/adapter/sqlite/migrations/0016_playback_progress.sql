CREATE TABLE playback_progress (
    video_source_id INTEGER PRIMARY KEY REFERENCES video_sources(id),
    position_ms INTEGER NOT NULL CHECK (position_ms >= 0 AND position_ms <= 9007199254740991)
);
