CREATE UNIQUE INDEX ux_video_sources_id_video_id
    ON video_sources(id, video_id);

CREATE TABLE media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    origin_source_id INTEGER,
    path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
    format TEXT NOT NULL CHECK (format IN ('mp4', 'webm')),
    size INTEGER NOT NULL CHECK (size > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    added_at TEXT NOT NULL,
    FOREIGN KEY (origin_source_id, video_id)
        REFERENCES video_sources(id, video_id)
);

CREATE UNIQUE INDEX ux_media_files_origin_source_id
    ON media_files(origin_source_id)
    WHERE origin_source_id IS NOT NULL;
