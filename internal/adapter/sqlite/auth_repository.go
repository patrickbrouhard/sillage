package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/patrickbrouhard/sillage/internal/auth"
)

// AuthRepository conserve l'identité et les sessions dans la base existante.
type AuthRepository struct{ db *sql.DB }

// NewAuthRepository réutilise les transactions et connexions de l'application.
func NewAuthRepository(db *sql.DB) *AuthRepository { return &AuthRepository{db: db} }

// Owner relit l'identité unique.
func (r *AuthRepository) Owner(ctx context.Context) (auth.Owner, error) {
	var owner auth.Owner
	err := r.db.QueryRowContext(ctx, `
  SELECT
      username,
      password_hash,
      version,
      managed,
      auth_policy,
       auth_managed,
       oidc_issuer,
       oidc_subject,
       oidc_client_id
  FROM owner
  WHERE id = 1
 `).Scan(
		&owner.Username,
		&owner.PasswordHash,
		&owner.Version,
		&owner.Managed,
		&owner.Authentication.Policy,
		&owner.Authentication.Managed,
		&owner.Authentication.Issuer,
		&owner.Authentication.Subject,
		&owner.Authentication.ClientID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		err = auth.ErrUninitialized
	}
	return owner, err
}

// CreateOwner laisse la contrainte singleton départager les initialisations concurrentes.
func (r *AuthRepository) CreateOwner(ctx context.Context, owner auth.Owner) error {
	result, err := r.db.ExecContext(ctx, `
  INSERT INTO owner (id, username, password_hash, version)
  VALUES (1, ?, ?, 1)
  ON CONFLICT(id) DO NOTHING
 `, owner.Username, owner.PasswordHash)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return auth.ErrExists
	}
	return err
}

// RecoverOwner remplace le secret et révoque toutes les sessions.
func (r *AuthRepository) RecoverOwner(ctx context.Context, hash string) error {
	return r.invalidate(ctx, &hash)
}

// RevokeAll empêche également une connexion antérieure de publier sa session tardivement.
func (r *AuthRepository) RevokeAll(ctx context.Context) error { return r.invalidate(ctx, nil) }

func (r *AuthRepository) invalidate(ctx context.Context, hash *string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if hash != nil {
		var managed bool
		err := tx.QueryRowContext(ctx, "SELECT managed FROM owner WHERE id = 1").Scan(&managed)
		if errors.Is(err, sql.ErrNoRows) {
			return auth.ErrUninitialized
		}
		if err != nil {
			return err
		}
		if managed {
			return auth.ErrManaged
		}
	}
	result, err := tx.ExecContext(ctx, `
  UPDATE owner
  SET version = version + 1,
      password_hash = COALESCE(?, password_hash)
  WHERE id = 1
 `, hash)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return auth.ErrUninitialized
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM web_sessions"); err != nil {
		return err
	}
	return tx.Commit()
}

// CreateSession compare la génération du propriétaire dans l'insertion elle-même.
func (r *AuthRepository) CreateSession(ctx context.Context, session auth.Session) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM web_sessions WHERE expires_at <= ?", session.CreatedAt.UnixMilli()); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `
  INSERT INTO web_sessions (token_hash, owner_version, created_at, expires_at, last_seen_at)
  SELECT
      ?,
      version,
      ?,
      ?,
      ?
  FROM owner
  WHERE id = 1 AND version = ?
 `, session.Hash, session.CreatedAt.UnixMilli(), session.ExpiresAt.UnixMilli(), session.LastSeenAt.UnixMilli(), session.Version)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return auth.ErrCredentials
	}
	return tx.Commit()
}

// Session renouvelle au plus une fois par intervalle, sans ressusciter une session révoquée.
func (r *AuthRepository) Session(ctx context.Context, hash string, now time.Time, lifetime, renewInterval time.Duration, touch bool) (auth.Session, error) {
	// La transaction sérialise renouvellement et révocation ; la lecture restitue
	// aussi l'échéance gagnante lorsque plusieurs requêtes arrivent ensemble.
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return auth.Session{}, err
	}
	defer tx.Rollback()
	if touch {
		_, err := tx.ExecContext(ctx, `
   UPDATE web_sessions
   SET expires_at = ?, last_seen_at = ?
   WHERE token_hash = ?
       AND expires_at > ?
       AND last_seen_at <= ?
       AND owner_version = (SELECT version FROM owner WHERE id = 1)
  `, now.Add(lifetime).UnixMilli(), now.UnixMilli(), hash, now.UnixMilli(), now.Add(-renewInterval).UnixMilli())
		if err != nil {
			return auth.Session{}, err
		}
	}
	var session auth.Session
	var created, expires, seen int64
	err = tx.QueryRowContext(ctx, `
  SELECT
      s.token_hash,
      s.owner_version,
      s.created_at,
      s.expires_at,
      s.last_seen_at
  FROM web_sessions AS s
  JOIN owner AS o
      ON o.id = s.owner_id AND o.version = s.owner_version
  WHERE s.token_hash = ? AND s.expires_at > ?
 `, hash, now.UnixMilli()).Scan(&session.Hash, &session.Version, &created, &expires, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return session, auth.ErrSession
	}
	if err != nil {
		return session, err
	}
	session.CreatedAt, session.ExpiresAt, session.LastSeenAt = time.UnixMilli(created), time.UnixMilli(expires), time.UnixMilli(seen)
	return session, tx.Commit()
}

// Revoke retire une seule session de manière idempotente.
func (r *AuthRepository) Revoke(ctx context.Context, hash string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM web_sessions WHERE token_hash = ?", hash)
	return err
}
