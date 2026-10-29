package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/patrickbrouhard/sillage/internal/auth"
)

func TestManagedProvisioningLifecycle(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "sillage.db")
	db := openTestDB(t, path)
	repo := NewAuthRepository(db)
	service := auth.NewService(repo, 0, 0)
	desired := &auth.Provisioning{Mode: "managed", Username: "owner", Password: "a sufficiently long password"}
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	original, _ := repo.Owner(ctx)
	token, err := service.Login(ctx, desired.Username, desired.Password)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db = openTestDB(t, path)
	repo = NewAuthRepository(db)
	service = auth.NewService(repo, 0, 0)
	// Une réécriture même identique doit faire échouer ce scénario.
	if _, err := db.Exec("CREATE TRIGGER block_owner_update BEFORE UPDATE ON owner BEGIN SELECT RAISE(ABORT, 'unexpected update'); END"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := service.Provision(ctx, desired); err != nil {
			t.Fatal(err)
		}
		current, _ := repo.Owner(ctx)
		if current != original {
			t.Fatal("unchanged declaration rewrote owner")
		}
		if _, err := service.Check(ctx, token); err != nil {
			t.Fatal("session lost on restart", err)
		}
	}
	if _, err := db.Exec("DROP TRIGGER block_owner_update"); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(service.Provision(ctx, nil), auth.ErrManaged) {
		t.Fatal("missing declaration accepted")
	}
	bootstrap := *desired
	bootstrap.Mode = "bootstrap"
	if !errors.Is(service.Provision(ctx, &bootstrap), auth.ErrManaged) {
		t.Fatal("implicit authority release")
	}
	if !errors.Is(service.Recover(ctx, "replacement local password"), auth.ErrManaged) {
		t.Fatal("local recovery bypassed authority")
	}
	// Un échec de révocation doit aussi annuler le changement d'identifiant et de secret.
	if _, err := db.Exec("CREATE TRIGGER block_revoke BEFORE DELETE ON web_sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END"); err != nil {
		t.Fatal(err)
	}
	rotated := *desired
	rotated.Username = "renamed-owner"
	rotated.Password = "a different password phrase"
	if err := service.Provision(ctx, &rotated); err == nil {
		t.Fatal("revocation failure ignored")
	}
	current, _ := repo.Owner(ctx)
	if current != original {
		t.Fatal("partial rotation committed")
	}
	if _, err := db.Exec("DROP TRIGGER block_revoke"); err != nil {
		t.Fatal(err)
	}
	if err := service.Provision(ctx, &rotated); err != nil {
		t.Fatal(err)
	}
	current, _ = repo.Owner(ctx)
	if current.Version != original.Version+1 || current.Username != rotated.Username || !current.Managed {
		t.Fatal("rotation missing")
	}
	if _, err := service.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal("old session survived")
	}
	if _, err := service.Login(ctx, desired.Username, desired.Password); !errors.Is(err, auth.ErrCredentials) {
		t.Fatal("old credentials survived")
	}
	if _, err := service.Login(ctx, rotated.Username, rotated.Password); err != nil {
		t.Fatal(err)
	}
	if err := repo.ConfigureOwner(ctx, original, original.Version); !errors.Is(err, auth.ErrOwnerChanged) {
		t.Fatal("stale update accepted")
	}
	if err := repo.CreateSession(ctx, auth.Session{Hash: "stale", Version: original.Version, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour), LastSeenAt: time.Now()}); !errors.Is(err, auth.ErrCredentials) {
		t.Fatal("stale login accepted")
	}
	if err := service.Release(ctx); err != nil {
		t.Fatal(err)
	}
	released, _ := repo.Owner(ctx)
	if released.Managed || released.Version != current.Version+1 {
		t.Fatal("explicit release missing")
	}
	if err := service.Release(ctx); err != nil {
		t.Fatal(err)
	}
	unchanged, _ := repo.Owner(ctx)
	if unchanged != released {
		t.Fatal("repeated release changed owner")
	}
	if err := service.Provision(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := service.Recover(ctx, "locally recovered password"); err != nil {
		t.Fatal(err)
	}

}

func TestBootstrapAndExplicitAdoption(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "sillage.db"))
	repo := NewAuthRepository(db)
	service := auth.NewService(repo, 0, 0)
	desired := &auth.Provisioning{Mode: "bootstrap", Username: "owner", Password: "a sufficiently long password"}
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	if err := service.Recover(ctx, "locally recovered password"); err != nil {
		t.Fatal(err)
	}
	original, _ := repo.Owner(ctx)
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	current, _ := repo.Owner(ctx)
	if current != original {
		t.Fatal("bootstrap overwrote recovery")
	}
	if err := service.Provision(ctx, nil); err != nil {
		t.Fatal(err)
	}
	desired.Mode = "managed"
	if !errors.Is(service.Provision(ctx, desired), auth.ErrAdoption) {
		t.Fatal("unapproved adoption")
	}
	current, _ = repo.Owner(ctx)
	if current != original {
		t.Fatal("refusal changed owner")
	}
	token, err := service.Login(ctx, "owner", "locally recovered password")
	if err != nil {
		t.Fatal(err)
	}
	desired.AdoptExisting = true
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	current, _ = repo.Owner(ctx)
	if !current.Managed || current.Version != original.Version+1 {
		t.Fatal("adoption missing")
	}
	if _, err := service.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal("session survived adoption")
	}
}

func TestMigrationPreservesLocalOwnerAndSession(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "existing.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	files := fstest.MapFS{}
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "0013" {
			continue
		}
		name := "migrations/" + entry.Name()
		data, err := fs.ReadFile(migrationFiles, name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = &fstest.MapFile{Data: data}
	}
	if err := migrate(ctx, db, files); err != nil {
		t.Fatal(err)
	}
	hash, err := auth.HashPassword("existing owner password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO owner (id,username,password_hash,version) VALUES (1,'owner',?,4)", hash); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := db.Exec("INSERT INTO web_sessions (token_hash,owner_version,created_at,expires_at,last_seen_at) VALUES (?,4,?,?,?)", auth.Digest("existing-session"), now.UnixMilli(), now.Add(time.Hour).UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	db.Close()
	migrated := openTestDB(t, path)
	repo := NewAuthRepository(migrated)
	service := auth.NewService(repo, 0, 0)
	if err := service.Provision(ctx, nil); err != nil {
		t.Fatal(err)
	}
	owner, err := repo.Owner(ctx)
	if err != nil || owner.Managed || owner.PasswordHash != hash || owner.Version != 4 {
		t.Fatal("migration changed existing owner")
	}
	if _, err := service.Check(ctx, "existing-session"); err != nil {
		t.Fatal("migration revoked session", err)
	}
}
