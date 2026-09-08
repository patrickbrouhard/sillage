package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestOpenMigratesAndConfiguresEveryConnection(t *testing.T) {
	// Les caractères réservés doivent rester dans le nom du fichier, pas le DSN.
	db := openTestDB(t, filepath.Join(t.TempDir(), "sillage ?# test.db"))
	ctx := context.Background()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		t.Fatalf("version = %d, error = %v", version, err)
	}
	var tables int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil || tables != 2 {
		t.Fatalf("table count = %d, error = %v", tables, err)
	}
	// Garder les connexions occupées oblige database/sql à en ouvrir plusieurs.
	for range 3 {
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		for pragma, want := range map[string]int{"foreign_keys": 1, "busy_timeout": 5000} {
			var got int
			if err := conn.QueryRowContext(ctx, "PRAGMA "+pragma).Scan(&got); err != nil || got != want {
				t.Fatalf("%s = %d, want %d, error = %v", pragma, got, want, err)
			}
		}
		var mode string
		if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode == "wal" {
			t.Fatalf("journal mode = %q, error = %v", mode, err)
		}
		if _, err := conn.ExecContext(ctx, "INSERT INTO video_sources (video_id, provider, title) VALUES (999, 'test', 'title')"); err == nil {
			t.Fatal("foreign key violation accepted")
		}
	}
}

func TestOpenRejectsFutureVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.db")
	db := openTestDB(t, path)
	if _, err := db.Exec("PRAGMA user_version = 2"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(context.Background(), path)
	if reopened != nil {
		reopened.Close()
		t.Fatal("returned a database for a future schema")
	}
	if err == nil || !strings.Contains(err.Error(), "unsupported schema version 2") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMigrationsAreOrderedAndTransactional(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "migrations.db"))
	files := fstest.MapFS{
		"migrations/0001_initial.sql": {Data: []byte("THIS MUST NOT RUN AGAIN")},
		"migrations/0002_second.sql":  {Data: []byte("CREATE TABLE second (id INTEGER)")},
		"migrations/0003_third.sql":   {Data: []byte("CREATE TABLE third (id INTEGER); INVALID SQL")},
	}
	if err := migrate(context.Background(), db, files); err == nil {
		t.Fatal("expected failed migration")
	}
	var version, count int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 2 {
		t.Fatalf("version = %d, error = %v", version, err)
	}
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name = 'third'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed migration left a table: count=%d error=%v", count, err)
	}
	files["migrations/0003_third.sql"] = &fstest.MapFile{Data: []byte("CREATE TABLE third (id INTEGER)")}
	if err := migrate(context.Background(), db, files); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 3 {
		t.Fatalf("version = %d, error = %v", version, err)
	}
}

// openTestDB crée une base réelle temporaire et garantit sa fermeture.
func openTestDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestConcurrentOpenMigratesOnce(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "concurrent-open.db")
	start := make(chan struct{})
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			db, err := Open(ctx, path)
			if err == nil {
				err = db.Close()
			}
			errs <- err
		}()
	}
	close(start)
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	db := openTestDB(t, path)
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
		t.Fatalf("version = %d, error = %v", version, err)
	}
}
