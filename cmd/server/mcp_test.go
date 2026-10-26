package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestMCPConfig vérifie l’activation explicite et refuse toute autorité réseau générale.
func TestMCPConfig(t *testing.T) {
	clearConfig(t)
	cfg, err := loadConfig()
	if err != nil || cfg.mcpEnabled || len(cfg.mcpAuthorities) != 3 {
		t.Fatalf("%+v %v", cfg, err)
	}
	t.Setenv("SILLAGE_MCP_ENABLED", "true")
	t.Setenv("SILLAGE_HTTP_ADDR", "0.0.0.0:9000")
	cfg, err = loadConfig()
	if err != nil || !cfg.mcpEnabled || cfg.mcpAuthorities[0] != "127.0.0.1:9000" {
		t.Fatalf("%+v %v", cfg, err)
	}
	t.Setenv("SILLAGE_MCP_ALLOWED_AUTHORITIES", "localhost:8081,127.0.0.1:8081")
	cfg, err = loadConfig()
	if err != nil || cfg.mcpAuthorities[0] != "localhost:8081" {
		t.Fatalf("%+v %v", cfg, err)
	}
	for _, value := range []string{"", "http://localhost:8080", "*:8080", "0.0.0.0:9000", "example.test:80"} {
		t.Setenv("SILLAGE_MCP_ALLOWED_AUTHORITIES", value)
		if _, err := loadConfig(); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	t.Setenv("SILLAGE_MCP_ENABLED", "invalid")
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid activation accepted")
	}
}

// TestRunMCP vérifie l'assemblage réel et son arrêt sur une bibliothèque vide isolée.
func TestRunMCP(t *testing.T) {
	builtWeb := os.Getenv("SILLAGE_TEST_DISTRIBUTED_WEB")
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "enabled"}[enabled], func(t *testing.T) {
			root := t.TempDir()
			t.Chdir(root)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			addr := listener.Addr().String()
			listener.Close()
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() {
				done <- run(ctx, config{
					addr: addr, postTimeout: time.Second, downloadTimeout: time.Minute,
					mcpEnabled: enabled, mcpAuthorities: []string{addr}, webDir: builtWeb,
				})
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(3 * time.Second):
					t.Error("server did not stop")
				}
			})
			client := &http.Client{Timeout: time.Second}
			ready := false
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				resp, err := client.Get("http://" + addr + "/api/v1/videos")
				if err == nil {
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					ready = true
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			if !ready {
				t.Fatal("server not ready")
			}
			if builtWeb != "" {
				response, err := client.Get("http://" + addr + "/")
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil || response.StatusCode != 200 || !strings.Contains(response.Header.Get("Content-Type"), "text/html") ||
					!strings.Contains(string(data), "<script") {
					t.Fatalf("distributed frontend not served: %d %v", response.StatusCode, err)
				}
			}
			resp, err := client.Get("http://" + addr + "/mcp")
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			want := 404
			if enabled {
				want = 405
			}
			if resp.StatusCode != want {
				t.Fatal(resp.StatusCode)
			}
			if enabled {
				c := sdk.NewClient(&sdk.Implementation{Name: "assembly", Version: "1"}, nil)
				session, err := c.Connect(context.Background(), &sdk.StreamableClientTransport{
					Endpoint: "http://" + addr + "/mcp", HTTPClient: client, DisableStandaloneSSE: true,
				}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
				if err != nil {
					t.Fatal(err)
				}
				defer session.Close()
				result, err := session.CallTool(context.Background(), &sdk.CallToolParams{Name: "search_videos", Arguments: map[string]any{"query": "Kubernetes", "sort": "newest"}})
				if err != nil || result.IsError {
					t.Fatalf("%+v %v", result, err)
				}
				data, _ := json.Marshal(result.StructuredContent)
				var page struct {
					Total   int
					Results []any
				}
				if err := json.Unmarshal(data, &page); err != nil || page.Total != 0 || page.Results == nil {
					t.Fatalf("%s %v", data, err)
				}
			}
		})
	}
}
