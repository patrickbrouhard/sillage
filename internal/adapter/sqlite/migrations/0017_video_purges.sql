-- L'absence de clé étrangère vers videos est intentionnelle : la vidéo a disparu.
CREATE TABLE video_purges (
    video_id INTEGER PRIMARY KEY
);

CREATE TABLE video_purge_files (
    video_id INTEGER NOT NULL REFERENCES video_purges(video_id),
    kind TEXT NOT NULL CHECK (kind IN ('media', 'asset', 'transcript')),
    path TEXT NOT NULL,
    PRIMARY KEY (video_id, kind, path)
);
