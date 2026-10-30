package http_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/playback"
)

func TestPlaybackREST(t *testing.T) {
	base, db := knowledgeAPI(t)
	h := api.WithPlayback(base, playback.NewService(sqlite.NewPlaybackRepository(db)))
	path := "/api/v1/videos/1/sources/1/playback-progress"
	checkPosition := func(w *httptest.ResponseRecorder, want string) {
		t.Helper()
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != want {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	checkPosition(request(h, "GET", path, "", ""), `{"position_ms":null}`)
	for _, body := range []string{
		"", "null", "[]", "{}", `{"position_ms":-1}`, `{"position_ms":1.5}`,
		`{"position_ms":"5"}`, `{"position_ms":false}`, `{"position_ms":{}}`,
		`{"position_ms":9007199254740992}`, `{"position_ms":9223372036854775808}`,
		`{"position_ms":1,"extra":true}`, `{"position_ms":1}{}`,
	} {
		assertError(t, request(h, "PUT", path, body, "application/json"), 400, "bad_request")
	}
	assertError(t, request(h, "PUT", path, `{"position_ms":1}`, "text/plain"), 415, "unsupported_media_type")
	assertError(t, request(h, "PUT", path, `{"position_ms":`+strings.Repeat("1", 1100)+"}", "application/json"), 413, "payload_too_large")
	for _, ids := range []string{"0/sources/1", "x/sources/1", "1/sources/-1", "1/sources/9223372036854775808"} {
		for _, method := range []string{"GET", "PUT"} {
			assertError(t, request(h, method, "/api/v1/videos/"+ids+"/playback-progress", `{"position_ms":0}`, "application/json"), 400, "bad_request")
		}
	}
	for _, ids := range []string{"1/sources/999", "2/sources/1", "999/sources/1"} {
		for _, method := range []string{"GET", "PUT"} {
			assertError(t, request(h, method, "/api/v1/videos/"+ids+"/playback-progress", `{"position_ms":0}`, "application/json"), 404, "video_source_not_found")
		}
	}
	for _, value := range []string{"5000", "9007199254740991", "0", "10000", "10000", "null", "null"} {
		body := `{"position_ms":` + value + "}"
		w := request(h, "PUT", path, body, "application/json")
		if w.Code != 204 || w.Body.Len() != 0 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		checkPosition(request(h, "GET", path, "", ""), body)
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM playback_progress").Scan(&count); err != nil || count != 0 {
		t.Fatalf("%d %v", count, err)
	}
}

func TestPlaybackAuthenticationAndCSRF(t *testing.T) {
	base, db := knowledgeAPI(t)
	service := auth.NewService(sqlite.NewAuthRepository(db), time.Hour, time.Minute)
	ctx := context.Background()
	if err := service.Initialize(ctx, "owner", "a sufficiently long password"); err != nil {
		t.Fatal(err)
	}
	token, err := service.Login(ctx, "owner", "a sufficiently long password")
	if err != nil {
		t.Fatal(err)
	}
	h, err := api.WithAuthentication(api.WithPlayback(base, playback.NewService(sqlite.NewPlaybackRepository(db))), service, "https://sillage.test")
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/videos/1/sources/1/playback-progress"
	call := func(method, body string, cookie bool, csrf, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://sillage.test"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", csrf)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if cookie {
			r.AddCookie(&http.Cookie{Name: "__Host-sillage_session", Value: token})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, method := range []string{"GET", "PUT"} {
		assertError(t, call(method, `{"position_ms":6000}`, false, "", ""), 401, "authentication_required")
	}
	csrf := auth.Digest("csrf:" + token)
	for _, value := range []string{"", "invalid"} {
		assertError(t, call("PUT", `{"position_ms":6000}`, true, value, ""), 403, "csrf_invalid")
	}
	w := call("PUT", `{"position_ms":6000}`, true, csrf, "https://evil.test")
	if w.Code != 403 {
		t.Fatalf("cross origin: %d", w.Code)
	}
	w = call("GET", "", true, "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "null") {
		t.Fatalf("unauthorized mutation: %s", w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store, private" {
		t.Fatal(w.Header())
	}
	for _, value := range []string{"6000", "null"} {
		if w := call("PUT", `{"position_ms":`+value+"}", true, csrf, "https://sillage.test"); w.Code != 204 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		w := call("GET", "", true, "", "")
		var got map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || string(got["position_ms"]) != value {
			t.Fatalf("%s %v", w.Body.String(), err)
		}
	}
}
