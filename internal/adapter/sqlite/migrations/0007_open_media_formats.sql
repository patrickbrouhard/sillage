-- Conserver le maximum historique, même si les lignes correspondantes ont disparu.
CREATE TEMP TABLE media_sequence_backup AS
SELECT seq FROM sqlite_sequence WHERE name = 'media_files';

CREATE TABLE media_files_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    origin_source_id INTEGER,
    path TEXT NOT NULL UNIQUE CHECK (length(path) > 0),
    format TEXT NOT NULL CHECK (length(trim(format)) > 0),
    size INTEGER NOT NULL CHECK (size > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    added_at TEXT NOT NULL,
    FOREIGN KEY (origin_source_id, video_id)
        REFERENCES video_sources(id, video_id)
);

INSERT INTO media_files_new (
    id,
    video_id,
    origin_source_id,
    path,
    format,
    size,
    duration_ms,
    added_at
)
SELECT
    id,
    video_id,
    origin_source_id,
    path,
    format,
    size,
    duration_ms,
    added_at
FROM media_files;

DROP TABLE media_files;
ALTER TABLE media_files_new RENAME TO media_files;

UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT MAX(seq) FROM media_sequence_backup), 0))
WHERE name = 'media_files';

DROP TABLE media_sequence_backup;

CREATE UNIQUE INDEX ux_media_files_origin_source_id
    ON media_files(origin_source_id)
    WHERE origin_source_id IS NOT NULL;
