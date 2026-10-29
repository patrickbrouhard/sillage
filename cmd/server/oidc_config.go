package main

import (
	"encoding/json"
	"path/filepath"

	external "github.com/patrickbrouhard/sillage/internal/adapter/oidc"
	"github.com/patrickbrouhard/sillage/internal/auth"
)

// loadOIDCConfig complète la déclaration validée avec le secret technique, hors du domaine.
func loadOIDCConfig(desired *auth.Provisioning, publicURL, path string, root map[string]json.RawMessage) (*external.Provider, error) {
	if desired == nil || desired.Authentication == nil || desired.Authentication.Policy == "local" {
		return nil, nil
	}
	fields, err := configObject(root["authentication"], "policy", "oidc")
	if err != nil {
		return nil, err
	}
	values, err := configObject(fields["oidc"], "issuer", "subject", "client_id", "client_secret_file")
	if err != nil {
		return nil, err
	}
	var secretPath string
	if json.Unmarshal(values["client_secret_file"], &secretPath) != nil || secretPath == "" {
		return nil, errProvisionConfig
	}
	if !filepath.IsAbs(secretPath) {
		secretPath = filepath.Join(filepath.Dir(path), secretPath)
	}
	secret, err := readPasswordFile(secretPath)
	if err != nil {
		return nil, err
	}
	a := desired.Authentication
	return external.New(external.Config{
		Issuer:      a.Issuer,
		Subject:     a.Subject,
		ClientID:    a.ClientID,
		Secret:      secret,
		RedirectURL: publicURL + "/api/v1/auth/oidc/callback",
	})
}
