package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
)

// backupBeforePublishers conserve la base complète avant la perte de creator.
// VACUUM INTO produit un snapshot cohérent, y compris si le journal contient des pages.
// Une erreur interdit la migration ; les sauvegardes antérieures ne sont jamais écrasées.
func backupBeforePublishers(ctx context.Context, db *sql.DB, path string) error {
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version < 1 || version >= 4 {
		return nil
	}
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".before-publishers-*.bak")
	if err != nil {
		return fmt.Errorf("reserve migration backup: %w", err)
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		return err
	}
	// SQLite accepte un fichier destination existant lorsqu'il est vide.
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", name); err != nil {
		return fmt.Errorf("backup before publisher migration to %s: %w", name, err)
	}
	backup, err := os.OpenFile(name, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer backup.Close()
	if err := backup.Sync(); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
