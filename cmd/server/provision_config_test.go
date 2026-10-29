package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProvisionConfiguration(t *testing.T) {
	clearConfig(t)
	root := t.TempDir()
	path := filepath.Join(root, "sillage.json")
	secret := "a private password phrase"
	if err := os.WriteFile(filepath.Join(root, "password"), []byte(secret), 0600); err != nil {
		t.Fatal(err)
	}
	valid := `{"version":1,"owner":{"mode":"managed","username":"owner","password_file":"password"}}`
	if err := os.WriteFile(path, []byte(valid), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SILLAGE_CONFIG_FILE", path)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.provisioning == nil || cfg.provisioning.Password != secret || cfg.provisioning.Mode != "managed" {
		t.Fatal("configuration not loaded")
	}
	invalid := []string{
		"", "null", "[]", valid + " {}", strings.Replace(valid, `"version":1`, `"version":2`, 1),
		strings.Replace(valid, `"version":1`, `"Version":1`, 1),
		strings.Replace(valid, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(valid, `"mode":"managed"`, `"mode":"bootstrap","adopt_existing":true`, 1),
		strings.Replace(valid, `"mode":"managed"`, `"mode":"managed","mode":"bootstrap"`, 1),
		strings.Replace(valid, `"mode":"managed"`, `"mode":null`, 1),
		strings.Replace(valid, `"username":"owner"`, `"username":" owner"`, 1),
		strings.Replace(valid, `"password_file":"password"`, `"password":"private-value"`, 1),
		strings.Replace(valid, `"password_file":"password"`, `"password_file":"missing-private-path"`, 1),
		strings.Replace(valid, `"mode":"managed"`, `"mode":"oidc"`, 1),
		strings.Replace(valid, `"username":"owner"`, "\"username\":\"\xff\"", 1),
		strings.Repeat(" ", 16385),
	}
	for i, input := range invalid {
		if err := os.WriteFile(path, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := loadConfig()
		if err == nil {
			t.Fatalf("invalid configuration %d accepted", i)
		}
		for _, forbidden := range []string{secret, "private-value", "missing-private-path", root} {
			if strings.Contains(err.Error(), forbidden) {
				t.Fatalf("diagnostic disclosed data for case %d", i)
			}
		}
	}
	t.Setenv("SILLAGE_CONFIG_FILE", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("explicit empty path accepted")
	}
}
