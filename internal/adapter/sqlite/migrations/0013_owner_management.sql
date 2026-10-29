-- L'autorité est durable : retirer le fichier ne réactive pas l'administration locale.
ALTER TABLE owner ADD COLUMN managed INTEGER NOT NULL DEFAULT 0 CHECK (managed IN (0, 1));
