package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	api "github.com/patrickbrouhard/sillage/internal/http"
)

func TestAuthenticationBoundary(t *testing.T) {
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := auth.NewService(sqlite.NewAuthRepository(db), time.Hour, time.Minute)
	if err := service.Initialize(context.Background(), "owner", "a sufficiently long password"); err != nil {
		t.Fatal(err)
	}
	calls := 0
	h, err := api.WithAuthentication(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) }), service, "https://sillage.test")
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string, cookies []*http.Cookie, csrf, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://sillage.test"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if csrf != "" {
			r.Header.Set("X-CSRF-Token", csrf)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		for _, c := range cookies {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/api/v1/videos", "/api/v1/search", "/api/v1/assets/1/content", "/api/v1/videos/1/media-files/1/content"} {
		for _, method := range []string{"GET", "HEAD", "POST", "DELETE"} {
			if w := request(method, path, "", nil, "", ""); w.Code != 401 {
				t.Fatalf("%s %s: %d", method, path, w.Code)
			}
		}
	}
	if calls != 0 {
		t.Fatal("private handler reached")
	}
	if w := request("GET", "/mcp", "", nil, "", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	w := request("GET", "/api/v1/auth/session", "", nil, "", "")
	var status struct {
		Authenticated bool
		CSRF          string `json:"csrf_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	pre := w.Result().Cookies()
	if len(pre) != 1 || !pre[0].Secure || !pre[0].HttpOnly || pre[0].SameSite != http.SameSiteLaxMode || pre[0].Domain != "" {
		t.Fatal(pre)
	}
	body := `{"username":"owner","password":"a sufficiently long password"}`
	if w := request("POST", "/api/v1/auth/login", body, pre, "", ""); w.Code != 403 {
		t.Fatal("missing CSRF", w.Code)
	}
	if w := request("POST", "/api/v1/auth/login", body, pre, status.CSRF, "https://evil.test"); w.Code != 403 {
		t.Fatal("cross origin", w.Code)
	}
	w = request("POST", "/api/v1/auth/login", body, pre, status.CSRF, "https://sillage.test")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	cookie := w.Result().Cookies()[0]
	if cookie.Name != "__Host-sillage_session" || !cookie.Secure || !cookie.HttpOnly {
		t.Fatal(cookie)
	}
	cookies := []*http.Cookie{cookie}
	if w := request("GET", "/api/v1/videos", "", cookies, "", ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request("DELETE", "/api/v1/videos/1/media-files/1", "", cookies, "", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request("DELETE", "/api/v1/videos/1/media-files/1", "", cookies, status.CSRF, ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request("POST", "/api/v1/auth/logout", "", cookies, status.CSRF, ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request("GET", "/api/v1/videos", "", cookies, "", ""); w.Code != 401 {
		t.Fatal("revocation", w.Code)
	}
	before := calls
	if _, err := db.Exec("DROP TABLE web_sessions"); err != nil {
		t.Fatal(err)
	}
	if w := request("GET", "/api/v1/videos", "", cookies, "", ""); w.Code != 503 {
		t.Fatal("storage error became logout", w.Code)
	}
	if calls != before {
		t.Fatal("failed open")
	}
}

func TestAuthenticationHostAndConfiguration(t *testing.T) {
	for _, value := range []string{"", "https://user:secret@example.com", "https://example.com/path", "ftp://example.com"} {
		if _, err := api.WithAuthentication(http.NotFoundHandler(), nil, value); err == nil {
			t.Fatal(value)
		}
	}
	h, err := api.WithAuthentication(http.NotFoundHandler(), nil, "http://localhost:8080")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://attacker.test/api/v1/videos", nil))
	if w.Code != 403 {
		t.Fatal(fmt.Sprint(w.Code))
	}
}

func TestAuthenticationInputAndExpiry(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := auth.NewService(sqlite.NewAuthRepository(db), time.Hour, time.Minute)
	// Ce secret admis nécessite plus de 4 Kio une fois échappé en JSON.
	password := strings.Repeat("\x01", 800)
	if err := service.Initialize(ctx, "owner", password); err != nil {
		t.Fatal(err)
	}
	privateCalls := 0
	newHandler := func() http.Handler {
		h, err := api.WithAuthentication(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			privateCalls++
			w.WriteHeader(204)
		}), service, "http://sillage.test")
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	h := newHandler()
	request := func(handler http.Handler, method, path, body string, cookies []*http.Cookie, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://sillage.test"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", csrf)
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	preauth := request(h, "GET", "/api/v1/auth/session", "", nil, "")
	var state struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.Unmarshal(preauth.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	cookies := preauth.Result().Cookies()
	for _, body := range []string{
		"null", "[]", `{"unknown":true}`, `{} {}`,
		"{\"username\":\"\xff\"}", strings.Repeat(" ", 8193),
	} {
		if w := request(h, "POST", "/api/v1/auth/login", body, cookies, state.CSRF); w.Code != 400 {
			t.Fatalf("invalid input accepted: %d", w.Code)
		}
	}
	body, _ := json.Marshal(map[string]string{"username": "owner", "password": password})
	logged := request(h, "POST", "/api/v1/auth/login", string(body), cookies, state.CSRF)
	if logged.Code != 200 {
		t.Fatalf("escaped password: %d", logged.Code)
	}
	cookie := logged.Result().Cookies()[0]
	if cookie.Secure || cookie.Name != "sillage_session" {
		t.Fatal("incorrect HTTP cookie policy")
	}
	if w := request(h, "GET", "/api/v1/videos", "", []*http.Cookie{cookie}, ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	for _, column := range []string{"expires_at", "last_seen_at"} {
		t.Run(column, func(t *testing.T) {
			token, err := service.Login(ctx, "owner", password)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("UPDATE web_sessions SET "+column+" = 0 WHERE token_hash = ?", auth.Digest(token)); err != nil {
				t.Fatal(err)
			}
			before := privateCalls
			expired := request(h, "GET", "/api/v1/videos", "", []*http.Cookie{{Name: "sillage_session", Value: token}}, "")
			if expired.Code != 401 || privateCalls != before {
				t.Fatal("expired session reached private handler")
			}
		})
	}

	// Les entrées rejetées sont aussi limitées, sans délai ni coût de hachage dans ce test.
	h = newHandler()
	preauth = request(h, "GET", "/api/v1/auth/session", "", nil, "")
	if err := json.Unmarshal(preauth.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	cookies = preauth.Result().Cookies()
	for range 10 {
		if w := request(h, "POST", "/api/v1/auth/login", "null", cookies, state.CSRF); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	limited := request(h, "POST", "/api/v1/auth/login", "null", cookies, state.CSRF)
	if limited.Code != 429 || limited.Header().Get("Retry-After") == "" {
		t.Fatal("login rate limit missing")
	}
}
