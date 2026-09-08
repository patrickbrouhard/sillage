package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// migrate applique les fichiers numérotés sans trou, une transaction par version.
// La version est relue sous le verrou d'écriture pour supporter deux ouvertures simultanées.
func migrate(ctx context.Context, db *sql.DB, files fs.FS) error {
	names, err := fs.Glob(files, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	for i, name := range names {
		prefix, _, ok := strings.Cut(strings.TrimPrefix(name, "migrations/"), "_")
		version, err := strconv.Atoi(prefix)
		if err != nil || !ok || len(prefix) != 4 || version != i+1 {
			return fmt.Errorf("invalid migration sequence at %q", name)
		}
	}
	for {
		done, err := migrateNext(ctx, db, files, names)
		if err != nil || done {
			return err
		}
	}
}

// migrateNext regroupe le SQL et user_version dans la même transaction.
func migrateNext(ctx context.Context, db *sql.DB, files fs.FS, names []string) (bool, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin migration: %w", err)
	}
	defer tx.Rollback()
	var current int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return false, fmt.Errorf("read schema version: %w", err)
	}
	if current < 0 || current > len(names) {
		return false, fmt.Errorf("unsupported schema version %d (maximum %d)", current, len(names))
	}
	if current == len(names) {
		return true, nil
	}
	script, err := fs.ReadFile(files, names[current])
	if err != nil {
		return false, fmt.Errorf("read migration: %w", err)
	}
	if _, err := tx.ExecContext(ctx, string(script)); err != nil {
		return false, fmt.Errorf("apply migration %s: %w", names[current], err)
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", current+1)); err != nil {
		return false, fmt.Errorf("set schema version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit migration: %w", err)
	}
	return false, nil
}
