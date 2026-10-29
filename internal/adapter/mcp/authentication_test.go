package mcp

import (
	"context"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type bearerTransport struct {
	base   http.RoundTripper
	secret string
}

// RoundTrip transmet l'identifiant sur chaque échange du vrai client SDK.
func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.secret)
	return b.base.RoundTrip(r)
}

func TestAuthenticatedSDKClientAndRevocation(t *testing.T) {
	ctx := context.Background()
	library := testLibrary(t)
	repository := sqlite.NewAuthRepository(library.db)
	identity := auth.NewService(repository, time.Hour, time.Hour)
	if err := identity.Initialize(ctx, "owner", "une phrase suffisamment longue"); err != nil {
		t.Fatal(err)
	}
	token, err := identity.Login(ctx, "owner", "une phrase suffisamment longue")
	if err != nil {
		t.Fatal(err)
	}
	keys := auth.NewAPIKeys(repository)
	key, secret, err := keys.Create(ctx, auth.Digest(token), "sdk", nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	mcp, err := New(ctx, library.readers, []string{origin})
	if err != nil {
		t.Fatal(err)
	}
	defer mcp.Close()
	handler, err := api.WithAuthentication(api.WithMCP(http.NotFoundHandler(), mcp), identity, origin)
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = api.WithAPIKeys(handler, keys, true)
	server.Start()
	defer server.Close()
	clientHTTP := &http.Client{Transport: bearerTransport{base: server.Client().Transport, secret: secret}}
	session := connectEndpoint(t, clientHTTP, server.URL+"/mcp", "2025-06-18")
	listed, err := session.ListTools(ctx, &sdk.ListToolsParams{})
	if err != nil || len(listed.Tools) != 4 {
		t.Fatal("tools", err)
	}
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "search_videos", Arguments: map[string]any{"query": ""}})
	if err != nil || result.IsError {
		t.Fatal("authenticated read", err)
	}
	if err := keys.Revoke(ctx, key.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "search_videos", Arguments: map[string]any{"query": ""}}); err == nil {
		t.Fatal("revoked credential accepted by existing client")
	}
}
