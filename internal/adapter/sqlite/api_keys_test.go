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
