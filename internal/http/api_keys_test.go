package http_test

import (
	"context"
	"encoding/json"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAPIKeysHTTPIsolation(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := sqlite.NewAuthRepository(db)
	identity := auth.NewService(repo, time.Hour, time.Hour)
	if err := identity.Initialize(ctx, "owner", "une phrase suffisamment longue"); err != nil {
		t.Fatal(err)
	}
	token, err := identity.Login(ctx, "owner", "une phrase suffisamment longue")
	if err != nil {
		t.Fatal(err)
	}
	h, err := api.WithAuthentication(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), identity, "http://127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	h = api.WithAPIKeys(h, auth.NewAPIKeys(repo), true)
	request := func(method, path, body, cookie, bearer, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: "sillage_session", Value: cookie})
		}
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		if csrf != "" {
			r.Header.Set("X-CSRF-Token", csrf)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	csrf := auth.Digest("csrf:" + token)
	if w := request("POST", "/api/v1/api-keys", `{"name":"test"}`, token, "", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := request("POST", "/api/v1/api-keys", `{"name":"test"}`, token, "", csrf)
	var created struct {
		Key    auth.APIKey
		Secret string
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &created) != nil || created.Secret == "" {
		t.Fatal(w.Code)
	}
	if w := request("GET", "/api/v1/api-keys", "", token, "", ""); strings.Contains(w.Body.String(), created.Secret) {
		t.Fatal("list leaked secret")
	}
	if w := request("POST", "/mcp", "", token, "", csrf); w.Code != 401 {
		t.Fatal("cookie accepted", w.Code)
	}
	if w := request("POST", "/mcp", "", "", created.Secret, ""); w.Code != 204 {
		t.Fatal("key rejected", w.Code)
	}
	if w := request("GET", "/api/v1/api-keys", "", "", created.Secret, ""); w.Code != 401 {
		t.Fatal("key reached REST", w.Code)
	}
	if w := request("DELETE", "/api/v1/api-keys/"+created.Key.ID, "", token, "", csrf); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request("POST", "/mcp", "", "", created.Secret, ""); w.Code != 401 {
		t.Fatal("revoked key accepted", w.Code)
	}
}
