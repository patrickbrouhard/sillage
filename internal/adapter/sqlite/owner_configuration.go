package sqlite

import (
	"context"

	"github.com/patrickbrouhard/sillage/internal/auth"
)

// ConfigureOwner applique une création ou un changement sensible avec révocation atomique.
// expectedVersion protège notamment contre une récupération ou une adoption concurrente.
func (r *AuthRepository) ConfigureOwner(ctx context.Context, owner auth.Owner, expectedVersion int64) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if expectedVersion == 0 {
		result, err := tx.ExecContext(ctx, `
   INSERT INTO owner (id, username, password_hash, version, managed)
   VALUES (1, ?, ?, 1, ?)
   ON CONFLICT(id) DO NOTHING
  `, owner.Username, owner.PasswordHash, owner.Managed)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return auth.ErrOwnerChanged
		}
	} else {
		// Même un démarrage inchangé vérifie sa génération sous verrou, sans UPDATE inutile.
		var current auth.Owner
		err := tx.QueryRowContext(ctx, `
   SELECT
       username,
       password_hash,
       version,
       managed
   FROM owner
   WHERE id = 1
  `).Scan(&current.Username, &current.PasswordHash, &current.Version, &current.Managed)
		if err != nil {
			return err
		}
		if current.Version != expectedVersion {
			return auth.ErrOwnerChanged
		}
		if current.Username == owner.Username && current.PasswordHash == owner.PasswordHash && current.Managed == owner.Managed {
			return tx.Commit()
		}
		result, err := tx.ExecContext(ctx, `
   UPDATE owner
   SET username = ?,
       password_hash = ?,
       managed = ?,
       version = version + 1
   WHERE id = 1 AND version = ?
  `, owner.Username, owner.PasswordHash, owner.Managed, expectedVersion)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return auth.ErrOwnerChanged
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM web_sessions"); err != nil {
			return err
		}
	}
	return tx.Commit()
}
