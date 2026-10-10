CREATE TABLE persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0)
);

CREATE TABLE publishers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
    name TEXT,
    person_id INTEGER REFERENCES persons(id),
    UNIQUE (provider, external_id)
);

CREATE INDEX ix_publishers_person_id ON publishers(person_id);

ALTER TABLE video_sources DROP COLUMN creator;
ALTER TABLE video_sources ADD COLUMN publisher_id INTEGER REFERENCES publishers(id);
CREATE INDEX ix_video_sources_publisher_id ON video_sources(publisher_id);

CREATE TABLE video_persons (
    video_id INTEGER NOT NULL REFERENCES videos(id),
    person_id INTEGER NOT NULL REFERENCES persons(id),
    PRIMARY KEY (video_id, person_id)
);
CREATE INDEX ix_video_persons_person_id ON video_persons(person_id, video_id);

CREATE TABLE publisher_tags (
    publisher_id INTEGER NOT NULL REFERENCES publishers(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (publisher_id, tag_id)
);
CREATE INDEX ix_publisher_tags_tag_id ON publisher_tags(tag_id, publisher_id);

CREATE TABLE person_tags (
    person_id INTEGER NOT NULL REFERENCES persons(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (person_id, tag_id)
);
CREATE INDEX ix_person_tags_tag_id ON person_tags(tag_id, person_id);

-- Les clés étrangères seules ne garantissent pas la cohérence du provider.
CREATE TRIGGER video_source_publisher_insert
BEFORE INSERT ON video_sources
WHEN NEW.publisher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM publishers
    WHERE id = NEW.publisher_id AND provider = NEW.provider
)
BEGIN
    SELECT RAISE(ABORT, 'incompatible publisher');
END;

CREATE TRIGGER video_source_publisher_update
BEFORE UPDATE OF publisher_id, provider ON video_sources
WHEN NEW.publisher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM publishers
    WHERE id = NEW.publisher_id AND provider = NEW.provider
)
BEGIN
    SELECT RAISE(ABORT, 'incompatible publisher');
END;

-- L'identité externe d'un compte n'est pas modifiable par cette tranche.
CREATE TRIGGER publisher_identity_update
BEFORE UPDATE OF provider, external_id ON publishers
WHEN NEW.provider <> OLD.provider OR NEW.external_id <> OLD.external_id
BEGIN
    SELECT RAISE(ABORT, 'immutable publisher identity');
END;
