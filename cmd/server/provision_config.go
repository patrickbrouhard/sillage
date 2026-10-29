package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/auth"
)

var errProvisionConfig = errors.New("invalid declarative configuration: expected version 1, owner and optional authentication policy")

// loadProvisioningEnv distingue l'absence volontaire d'un chemin déclaré mais inutilisable.
func loadProvisioningEnv() (*auth.Provisioning, error) {
	path, present := os.LookupEnv("SILLAGE_CONFIG_FILE")
	if !present {
		return nil, nil
	}
	if path == "" {
		return nil, errProvisionConfig
	}
	return loadProvisioning(path)
}

// loadProvisioning borne le document ; les diagnostics n'incluent ni chemin ni valeur fournie.
func loadProvisioning(path string) (*auth.Provisioning, error) {
	return readProvisioning(path, nil)
}

// readProvisioning partage une seule lecture validée avec le chargement du fournisseur.
func readProvisioning(path string, inspect func(*auth.Provisioning, map[string]json.RawMessage) error) (*auth.Provisioning, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errProvisionConfig
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errProvisionConfig
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 16385))
	if err != nil || len(data) > 16384 || !utf8.Valid(data) {
		return nil, errProvisionConfig
	}
	root, err := configObject(data, "version", "owner", "authentication")
	if err != nil {
		return nil, err
	}
	var version int
	if json.Unmarshal(root["version"], &version) != nil || version != 1 {
		return nil, errProvisionConfig
	}
	fields, err := configObject(root["owner"], "mode", "username", "password_file", "adopt_existing")
	if err != nil {
		return nil, err
	}
	var mode, username, secretPath string
	var adopt bool
	if json.Unmarshal(fields["mode"], &mode) != nil ||
		json.Unmarshal(fields["username"], &username) != nil {
		return nil, errProvisionConfig
	}
	if value, ok := fields["adopt_existing"]; ok && json.Unmarshal(value, &adopt) != nil {
		return nil, errProvisionConfig
	}
	if mode != "managed" && mode != "bootstrap" {
		return nil, errProvisionConfig
	}
	var password string
	if value, ok := fields["password_file"]; ok {
		if json.Unmarshal(value, &secretPath) != nil || secretPath == "" {
			return nil, errProvisionConfig
		}
		if !filepath.IsAbs(secretPath) {
			secretPath = filepath.Join(filepath.Dir(path), secretPath)
		}
		password, err = readPasswordFile(secretPath)
		if err != nil {
			return nil, err
		}
	}
	desired := &auth.Provisioning{Mode: mode, Username: username, Password: password, AdoptExisting: adopt}
	if value, ok := root["authentication"]; ok {
		fields, err := configObject(value, "policy", "oidc")
		if err != nil {
			return nil, err
		}
		a := &auth.Authentication{Managed: true}
		if json.Unmarshal(fields["policy"], &a.Policy) != nil {
			return nil, errProvisionConfig
		}
		if value, ok := fields["oidc"]; ok {
			oidc, err := configObject(value, "issuer", "subject", "client_id", "client_secret_file")
			if err != nil {
				return nil, err
			}
			if json.Unmarshal(oidc["issuer"], &a.Issuer) != nil || json.Unmarshal(oidc["subject"], &a.Subject) != nil || json.Unmarshal(oidc["client_id"], &a.ClientID) != nil {
				return nil, errProvisionConfig
			}
		}
		desired.Authentication = a
	}

	if err := desired.Validate(); err != nil {
		return nil, err
	}
	if inspect != nil {
		if err := inspect(desired, root); err != nil {
			return nil, err
		}
	}
	return desired, nil
}

// configObject refuse aussi doublons, null et variantes de casse, sans fusion implicite.
func configObject(data []byte, allowed ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errProvisionConfig
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return nil, errProvisionConfig
		}
		known := false
		for _, name := range allowed {
			if key == name {
				known = true
			}
		}
		if _, duplicate := fields[key]; duplicate || !known {
			return nil, errProvisionConfig
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errProvisionConfig
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errProvisionConfig
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errProvisionConfig
	}
	return fields, nil
}
