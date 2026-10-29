package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	api "github.com/patrickbrouhard/sillage/internal/http"
)

type externalStub struct {
	failed  bool
	entered chan struct{}
	resume  chan struct{}
}

func (s *externalStub) AuthorizationURL(_ context.Context, state, nonce, verifier string) (string, error) {
	if s.failed {
		return "", errors.New("provider unavailable")
	}
	return "https://provider.test/authorize?state=" + url.QueryEscape(state), nil
}
func (s *externalStub) Verify(context.Context, string, string, string) error {
	if s.entered != nil {
		close(s.entered)
		<-s.resume
	}
	return nil
}

func TestOIDCTransactionsAndLogout(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := auth.NewService(sqlite.NewAuthRepository(db), 0, 0)
	if err := service.Provision(ctx, &auth.Provisioning{Mode: "managed", Username: "owner", Authentication: &auth.Authentication{Policy: "oidc", Issuer: "https://provider.test", Subject: "owner", ClientID: "client"}}); err != nil {
		t.Fatal(err)
	}
	external := &externalStub{}
	handler, err := api.WithAuthentication(http.NotFoundHandler(), service, "https://sillage.test", external)
	if err != nil {
		t.Fatal(err)
	}
	cookies := map[string]*http.Cookie{}
	request := func(method, path, csrf string, sendCookies bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://sillage.test"+path, nil)
		r.Header.Set("X-CSRF-Token", csrf)
		if sendCookies {
			for _, c := range cookies {
				r.AddCookie(c)
			}
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	absorb := func(w *httptest.ResponseRecorder) {
		for _, c := range w.Result().Cookies() {
			if c.MaxAge < 0 {
				delete(cookies, c.Name)
			} else {
				cookies[c.Name] = c
			}
		}
	}
	session := func() string {
		w := request("GET", "/api/v1/auth/session", "", true)
		if w.Code != 200 {
			t.Fatalf("session %d", w.Code)
		}
		absorb(w)
		var data struct {
			CSRF    string `json:"csrf_token"`
			Methods string `json:"methods"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &data)
		if data.Methods != "oidc" {
			t.Fatal("wrong methods")
		}
		return data.CSRF
	}
	start := func() string {
		csrf := session()
		w := request("POST", "/api/v1/auth/oidc/start", csrf, true)
		if w.Code != 200 {
			t.Fatalf("start %d: %s", w.Code, w.Body.String())
		}
		absorb(w)
		var data map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &data)
		u, _ := url.Parse(data["url"])
		return "/api/v1/auth/oidc/callback?code=code&state=" + url.QueryEscape(u.Query().Get("state"))
	}
	if w := request("POST", "/api/v1/auth/oidc/start", "", false); w.Code != 403 {
		t.Fatal("start without CSRF accepted")
	}
	callback := start()
	if w := request("GET", callback, "", false); w.Code != 400 {
		t.Fatal("unbound browser accepted")
	}
	w := request("GET", callback, "", true)
	if w.Code != 303 {
		t.Fatalf("callback %d", w.Code)
	}
	absorb(w)
	if w := request("GET", callback, "", true); w.Code != 400 {
		t.Fatal("replay accepted")
	}
	// Une panne du fournisseur ne touche pas la session déjà établie, même avec un nouvel handler.
	external.failed = true
	restarted, err := api.WithAuthentication(http.NotFoundHandler(), service, "https://sillage.test", external)
	if err != nil {
		t.Fatal(err)
	}
	handler = restarted
	csrfUnavailable := session()
	if failed := request("POST", "/api/v1/auth/oidc/start", csrfUnavailable, true); failed.Code != 503 {
		t.Fatal("provider outage not reported")
	}
	current := cookies["__Host-sillage_session"]
	if current == nil {
		t.Fatal("missing session cookie")
	}
	if _, err := service.Check(ctx, current.Value); err != nil {
		t.Fatal("provider outage revoked session", err)
	}
	external.failed = false
	// Une nouvelle transaction est en vol pendant une déconnexion de la session courante.
	callback = start()
	external.entered = make(chan struct{})
	external.resume = make(chan struct{})
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- request("GET", callback, "", true) }()
	<-external.entered
	csrf := session()
	w = request("POST", "/api/v1/auth/logout", csrf, true)
	if w.Code != 204 {
		t.Fatalf("logout %d", w.Code)
	}
	close(external.resume)
	if w := <-done; w.Code != 400 {
		t.Fatalf("late callback accepted: %d", w.Code)
	}
	absorb(w)
	if w := request("GET", "/api/v1/videos", "", true); w.Code != 401 {
		t.Fatal("logout did not revoke")
	}
	external.entered = nil
	callback = start()
	if err := service.RecoverAuthentication(ctx, "long enough local password"); !(err == auth.ErrManaged) {
		t.Fatal("managed credentials released implicitly")
	}
	// logout-all invalide aussi une authentification commencée sans session courante.
	if err := service.LogoutAll(ctx); err != nil {
		t.Fatal(err)
	}
	if w := request("GET", callback, "", true); w.Code != 401 {
		t.Fatal("stale generation accepted")
	}
}
