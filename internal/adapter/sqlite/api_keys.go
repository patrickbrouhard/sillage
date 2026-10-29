package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"github.com/patrickbrouhard/sillage/internal/auth"
	"time"
)

// CreateKey vérifie la session dans la même transaction que l'insertion : une
// déconnexion gagnante interdit toute émission tardive d'un identifiant durable.
func (r *AuthRepository) CreateKey(ctx context.Context, key auth.APIKey, sessionHash string, idle time.Duration) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var expires any
	if key.ExpiresAt != nil {
		expires = key.ExpiresAt.UnixMilli()
	}
	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, `
 INSERT INTO api_keys (id, name, token_hash, permission, created_at, expires_at)
 SELECT ?, ?, ?, ?, ?, ?
 FROM web_sessions AS s
 JOIN owner AS o
     ON o.id = s.owner_id AND o.version = s.owner_version
 WHERE s.token_hash = ?
     AND s.expires_at > ?
     AND s.last_seen_at > ?
 `, key.ID, key.Name, key.Hash, key.Permission, key.CreatedAt.UnixMilli(), expires, sessionHash, now.UnixMilli(), now.Add(-idle).UnixMilli())
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return auth.ErrSession
	}
	return tx.Commit()
}

// ListKeys omet l'empreinte et conserve les révocations pour lever les résultats incertains.
func (r *AuthRepository) ListKeys(ctx context.Context) ([]auth.APIKey, error) {
	rows, err := r.db.QueryContext(ctx, `
 SELECT
     id,
     name,
     permission,
     created_at,
     expires_at,
     revoked_at
 FROM api_keys
 ORDER BY created_at DESC, id
 `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []auth.APIKey{}
	for rows.Next() {
		var key auth.APIKey
		var created int64
		var expires, revoked sql.NullInt64
		if err := rows.Scan(&key.ID, &key.Name, &key.Permission, &created, &expires, &revoked); err != nil {
			return nil, err
		}
		key.CreatedAt = time.UnixMilli(created).UTC()
		if expires.Valid {
			value := time.UnixMilli(expires.Int64).UTC()
			key.ExpiresAt = &value
		}
		if revoked.Valid {
			value := time.UnixMilli(revoked.Int64).UTC()
			key.RevokedAt = &value
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

// CheckKey compare une empreinte aléatoire indexée, jamais un secret en clair.
func (r *AuthRepository) CheckKey(ctx context.Context, hash string, now time.Time) error {
	var found int
	err := r.db.QueryRowContext(ctx, `
 SELECT 1
 FROM api_keys
 WHERE token_hash = ?
     AND permission = 'mcp:read'
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > ?)
 `, hash, now.UnixMilli()).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.ErrAPIKey
	}
	return err
}

// RevokeKey est idempotent même pour un identifiant déjà révoqué ou inconnu.
func (r *AuthRepository) RevokeKey(ctx context.Context, id string, now time.Time) error {
	_, err := r.db.ExecContext(ctx, `
 UPDATE api_keys
 SET revoked_at = ?
 WHERE id = ? AND revoked_at IS NULL
 `, now.UnixMilli(), id)
	return err
}

// RevokeKeys invalide atomiquement toutes les clés existantes.
func (r *AuthRepository) RevokeKeys(ctx context.Context, now time.Time) error {
	_, err := r.db.ExecContext(ctx, `
 UPDATE api_keys
 SET revoked_at = ?
 WHERE revoked_at IS NULL
 `, now.UnixMilli())
	return err
}

// ResetAccess conserve l'autorité déclarative tout en invalidant les connexions
// commencées avant l'incident et les créations concurrentes issues de leurs sessions.
func (r *AuthRepository) ResetAccess(ctx context.Context, now time.Time) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "UPDATE owner SET version = version + 1 WHERE id = 1"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM web_sessions"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE api_keys SET revoked_at = ? WHERE revoked_at IS NULL", now.UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}
