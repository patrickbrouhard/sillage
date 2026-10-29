package sqlite

import (
	"context"
	"errors"
	"github.com/patrickbrouhard/sillage/internal/auth"
	"path/filepath"
	"testing"
	"time"
)

func TestAPIKeyLifecycleAndSessionFence(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "keys.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewAuthRepository(db)
	identity := auth.NewService(repo, time.Hour, time.Hour)
	if err := identity.Initialize(ctx, "owner", "une phrase suffisamment longue"); err != nil {
		t.Fatal(err)
	}
	token, err := identity.Login(ctx, "owner", "une phrase suffisamment longue")
	if err != nil {
		t.Fatal(err)
	}
	keys := auth.NewAPIKeys(repo, time.Hour)
	key, secret, err := keys.Create(ctx, auth.Digest(token), "Codex", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := keys.Check(ctx, secret); err != nil {
		t.Fatal(err)
	}
	var hash string
	if err := db.QueryRow("SELECT token_hash FROM api_keys WHERE id = ?", key.ID).Scan(&hash); err != nil || hash == secret {
		t.Fatal("raw credential stored", err)
	}
	if err := identity.Logout(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := keys.Create(ctx, auth.Digest(token), "late", nil); !errors.Is(err, auth.ErrSession) {
		t.Fatal("revoked session issued key", err)
	}
	if err := keys.Check(ctx, secret); err != nil {
		t.Fatal("web logout revoked integration", err)
	}
	if err := keys.Revoke(ctx, key.ID); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(keys.Check(ctx, secret), auth.ErrAPIKey) {
		t.Fatal("revoked key accepted")
	}
	token, err = identity.Login(ctx, "owner", "une phrase suffisamment longue")
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err = keys.Create(ctx, auth.Digest(token), "replacement", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := keys.ResetAccess(ctx); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(keys.Check(ctx, secret), auth.ErrAPIKey) {
		t.Fatal("reset retained key")
	}
	if _, err := identity.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal("reset retained session", err)
	}
}

func TestConcurrentKeyCreationAndSecurityReset(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "race.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewAuthRepository(db)
	identity := auth.NewService(repo, time.Hour, time.Hour)
	keys := auth.NewAPIKeys(repo, time.Hour)
	if err := identity.Initialize(ctx, "owner", "une phrase suffisamment longue"); err != nil {
		t.Fatal(err)
	}
	token, err := identity.Login(ctx, "owner", "une phrase suffisamment longue")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	finished := make(chan error, 2)
	go func() {
		<-start
		_, _, err := keys.Create(ctx, auth.Digest(token), "concurrent", nil)
		if errors.Is(err, auth.ErrSession) {
			err = nil
		}
		finished <- err
	}()
	go func() { <-start; finished <- keys.ResetAccess(ctx) }()
	close(start)
	for range 2 {
		if err := <-finished; err != nil {
			t.Fatal(err)
		}
	}
	var active int
	if err := db.QueryRow("SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL").Scan(&active); err != nil || active != 0 {
		t.Fatal("key survived reset", err)
	}
}

func TestKeyExpirationAndAdministrativeChanges(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "expiry.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewAuthRepository(db)
	identity := auth.NewService(repo, time.Hour, time.Hour)
	keys := auth.NewAPIKeys(repo, time.Hour)
	if err := identity.Initialize(ctx, "owner", "une phrase suffisamment longue"); err != nil {
		t.Fatal(err)
	}
	token, err := identity.Login(ctx, "owner", "une phrase suffisamment longue")
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	key, secret, err := keys.Create(ctx, auth.Digest(token), "expiring", &expires)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.CheckKey(ctx, key.Hash, expires.Add(time.Millisecond)); !errors.Is(err, auth.ErrAPIKey) {
		t.Fatal("expired key accepted", err)
	}
	owner, err := repo.Owner(ctx)
	if err != nil {
		t.Fatal(err)
	}
	owner.Authentication = auth.Authentication{Policy: "oidc", Issuer: "https://identity.example", Subject: "replacement", ClientID: "new-client", Managed: true}
	if err := repo.ConfigureOwner(ctx, owner, owner.Version); err != nil {
		t.Fatal(err)
	}
	if err := keys.Check(ctx, secret); err != nil {
		t.Fatal("administrative change revoked key", err)
	}
	if err := keys.RevokeAll(ctx); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(keys.Check(ctx, secret), auth.ErrAPIKey) {
		t.Fatal("global revocation ignored")
	}
}
