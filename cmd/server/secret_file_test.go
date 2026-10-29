package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadPasswordFile(t *testing.T) {
	for _, content := range []string{"a long password phrase", "  a long password phrase\n", strings.Repeat("a", 1024)} {
		path := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := readPasswordFile(path)
		if err != nil || got != content {
			t.Fatal("secret bytes changed or rejected")
		}
	}
}

func TestReadPasswordFileRejectsInvalidInputs(t *testing.T) {
	directory := t.TempDir()
	for _, content := range []string{"", strings.Repeat("x", 1025)} {
		path := filepath.Join(directory, "private-secret-name")
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readPasswordFile(path); err == nil || strings.Contains(err.Error(), path) {
			t.Fatal("invalid file accepted or path disclosed")
		}
	}
	for _, path := range []string{directory, filepath.Join(directory, "missing-private-secret")} {
		if _, err := readPasswordFile(path); err == nil || strings.Contains(err.Error(), path) {
			t.Fatal("invalid path accepted or disclosed")
		}
	}
}
