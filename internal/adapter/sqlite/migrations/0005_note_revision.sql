-- Les notes existantes gardent intégralement leur texte et leurs dates.
ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
