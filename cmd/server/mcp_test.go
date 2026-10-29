package main

import (
	"context"
	"strings"
	"testing"
)

func TestMCPActivationConfiguration(t *testing.T) {
	clearConfig(t)
	for _, scenario := range []struct {
		value    string
		explicit bool
		want     bool
	}{
		{want: true},
		{value: "true", explicit: true, want: true},
		{value: "false", explicit: true, want: false},
	} {
		t.Run(scenario.value, func(t *testing.T) {
			if scenario.explicit {
				t.Setenv("SILLAGE_MCP_ENABLED", scenario.value)
			}
			cfg, err := loadConfig()
			if err != nil || cfg.mcpEnabled != scenario.want {
				t.Fatalf("enabled=%v, want=%v, error=%v", cfg.mcpEnabled, scenario.want, err)
			}
		})
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
