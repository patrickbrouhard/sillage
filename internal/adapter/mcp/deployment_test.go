package mcp

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestDeployedMCP contrôle un vrai serveur jetable fourni par l'opérateur, sans aucune écriture.
// La construction, l'isolation du volume et le nettoyage Docker restent explicites dans la recette.
func TestDeployedMCP(t *testing.T) {
	endpoint := os.Getenv("SILLAGE_TEST_MCP_DEPLOYMENT")
	if endpoint == "" {
		t.Skip("opt-in isolated deployment")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.Path != "" || parsed.User != nil {
		t.Fatal("expected local HTTP base URL")
	}
	if _, err := localAuthority(parsed.Host); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	for _, version := range supportedProtocolVersions {
		session := connectEndpoint(t, client, endpoint+"/mcp", version)
		listed, err := session.ListTools(context.Background(), nil)
		if err != nil || len(listed.Tools) != 4 {
			t.Fatalf("discovery: %v %v", listed, err)
		}
		for _, tool := range listed.Tools {
			if !knownTool(tool.Name) {
				t.Fatal("unexpected tool")
			}
		}
		result := call(t, session, "search_videos", map[string]any{"query": "Kubernetes", "sort": "newest"})
		if result.IsError {
			t.Fatal("local search failed")
		}
		page := decode[searchDTO](t, result)
		if page.Page != 1 || page.Results == nil {
			t.Fatal("invalid page")
		}
		t.Logf("deployed SDK connection/read protocol=%s results=%d total=%d", version, len(page.Results), page.Total)
	}
	get := func(path string) string {
		response, err := client.Get(endpoint + path)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("GET %s status=%d error=%v", path, response.StatusCode, err)
		}
		return string(data)
	}
	if !strings.Contains(get("/api/v1/videos"), "videos") {
		t.Fatal("REST list missing")
	}
	html := get("/")
	if !strings.Contains(html, "<script") || get("/videos/123") != html {
		t.Fatal("SPA routing failed")
	}
	script := regexp.MustCompile(`src="(/assets/[^"]+\.js)"`).FindStringSubmatch(html)
	if len(script) != 2 || !strings.HasPrefix(script[1], "/assets/") {
		t.Fatal("distributed script missing")
	}
	get(script[1])
	for _, tc := range []struct {
		host, origin string
		status       int
	}{
		{parsed.Host, "", 200},
		{parsed.Host, endpoint, 200},
		{"127.0.0.1:1", "", 403},
		{parsed.Host, "http://untrusted.test", 403},
	} {
		req, _ := http.NewRequest("POST", endpoint+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		req.Host = tc.host
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != tc.status {
			t.Fatalf("authority check status=%d", response.StatusCode)
		}
	}
	t.Log("deployed REST, SPA, distributed asset and authority checks passed")
}
