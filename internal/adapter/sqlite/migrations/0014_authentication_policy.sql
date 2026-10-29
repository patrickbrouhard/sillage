-- Le défaut conserve les installations locales sans activer de nouvelle méthode.
ALTER TABLE owner ADD COLUMN auth_policy TEXT NOT NULL DEFAULT 'local' CHECK (auth_policy IN ('local', 'both', 'oidc'));
ALTER TABLE owner ADD COLUMN auth_managed INTEGER NOT NULL DEFAULT 0 CHECK (auth_managed IN (0, 1));
ALTER TABLE owner ADD COLUMN oidc_issuer TEXT NOT NULL DEFAULT '';
ALTER TABLE owner ADD COLUMN oidc_subject TEXT NOT NULL DEFAULT '';
ALTER TABLE owner ADD COLUMN oidc_client_id TEXT NOT NULL DEFAULT '';
