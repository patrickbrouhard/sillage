package main

import (
	"context"
	"strings"
	"testing"
)

func TestMCPActivationConfiguration(t *testing.T) {
	clearConfig(t)
	t.Setenv("SILLAGE_MCP_ENABLED", "true")
	if _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SILLAGE_MCP_ENABLED", "invalid")
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid flag accepted")
	}
}

func TestUninitializedServerRefusesAccess(t *testing.T) {
	t.Chdir(t.TempDir())
	err := run(context.Background(), config{addr: "127.0.0.1:0"})
	if err == nil || !strings.Contains(err.Error(), "owner not initialized") {
		t.Fatal(err)
	}
}
