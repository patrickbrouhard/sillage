package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/auth"
)

func TestAuthenticationAuthorityLifecycle(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "policy.db"))
	repo := NewAuthRepository(db)
	service := auth.NewService(repo, 0, 0)
	desired := &auth.Provisioning{Mode: "bootstrap", Username: "owner", Authentication: &auth.Authentication{Policy: "oidc", Issuer: "https://issuer.test", Subject: "subject", ClientID: "client"}}
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	original, _ := repo.Owner(ctx)
	if original.PasswordHash != "" || original.Managed || !original.Authentication.Managed {
		t.Fatal("authorities not separated")
	}
	generation, err := service.BeginExternal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	token, err := service.CompleteExternal(ctx, generation)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(ctx, token); err != nil {
		t.Fatal("unchanged declaration revoked session", err)
	}
	if _, err := service.Login(ctx, "owner", ""); !errors.Is(err, auth.ErrCredentials) {
		t.Fatal("local login enabled")
	}
	if err := service.Provision(ctx, nil); !errors.Is(err, auth.ErrManaged) {
		t.Fatal("missing authority accepted")
	}
	removed := *desired
	removed.Authentication = nil
	removed.Password = "long enough local password"
	if err := service.Provision(ctx, &removed); !errors.Is(err, auth.ErrManaged) {
		t.Fatal("missing authentication block accepted")
	}
	desired.Authentication.Subject = "replacement"
	if _, err := db.Exec("CREATE TRIGGER reject_revoke BEFORE DELETE ON web_sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END"); err != nil {
		t.Fatal(err)
	}
	if err := service.Provision(ctx, desired); err == nil {
		t.Fatal("partial rotation accepted")
	}
	after, _ := repo.Owner(ctx)
	if after != original {
		t.Fatal("failed rotation changed owner")
	}
	if _, err := db.Exec("DROP TRIGGER reject_revoke"); err != nil {
		t.Fatal(err)
	}
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal("session survived identity change")
	}
	if _, err := service.CompleteExternal(ctx, generation); !errors.Is(err, auth.ErrCredentials) {
		t.Fatal("pending login survived")
	}
	if err := service.RecoverAuthentication(ctx, "new local password phrase"); err != nil {
		t.Fatal(err)
	}
	recovered, _ := repo.Owner(ctx)
	if recovered.Authentication.Policy != "local" || recovered.Authentication.Managed {
		t.Fatal("explicit recovery failed")
	}
	if _, err := service.Login(ctx, "owner", "new local password phrase"); err != nil {
		t.Fatal(err)
	}
	desired.Password = "ignored bootstrap password"
	if err := service.Provision(ctx, desired); !errors.Is(err, auth.ErrAdoption) {
		t.Fatal("implicit adoption accepted")
	}
	desired.AdoptExisting = true
	desired.Authentication.Policy = "both"
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Login(ctx, "owner", "new local password phrase"); err != nil {
		t.Fatal("bootstrap replaced local password", err)
	}
	generation, _ = service.BeginExternal(ctx)
	token, _ = service.CompleteExternal(ctx, generation)
	desired.Authentication.ClientID = "replacement-client"
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal("client change failed to revoke")
	}
	desired.Authentication = &auth.Authentication{Policy: "local"}
	if err := service.Provision(ctx, desired); err != nil {
		t.Fatal(err)
	}
	if _, err := service.BeginExternal(ctx); !errors.Is(err, auth.ErrCredentials) {
		t.Fatal("OIDC enabled under local policy")
	}
}
