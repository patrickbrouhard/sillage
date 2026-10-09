CREATE TABLE notes (
    video_id INTEGER PRIMARY KEY REFERENCES videos(id),
    content_md TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (name <> ''),
    identity_key TEXT NOT NULL UNIQUE CHECK (identity_key <> '')
);

CREATE TABLE video_tags (
    video_id INTEGER NOT NULL REFERENCES videos(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (video_id, tag_id)
);

CREATE INDEX ix_video_tags_tag_id_video_id
    ON video_tags(tag_id, video_id);
