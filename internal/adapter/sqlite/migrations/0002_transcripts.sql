ALTER TABLE video_sources ADD COLUMN original_audio_language TEXT;

CREATE TABLE transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_source_id INTEGER NOT NULL REFERENCES video_sources(id),
    language TEXT NOT NULL CHECK (length(trim(language)) > 0),
    provenance TEXT NOT NULL CHECK (length(trim(provenance)) > 0),
    local_path TEXT,
    last_fetched_at TEXT NOT NULL,
    UNIQUE (video_source_id, language, provenance)
);
