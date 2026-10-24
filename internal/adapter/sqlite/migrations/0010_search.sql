CREATE VIRTUAL TABLE video_search USING fts5(
    titles,
    tags,
    note,
    publishers,
    descriptions,
    tokenize = "unicode61 remove_diacritics 2 tokenchars '+#'"
);

CREATE TABLE search_projection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);
