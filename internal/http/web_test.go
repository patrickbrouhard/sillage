package http_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	api "github.com/patrickbrouhard/sillage/internal/http"
)

func TestWebRouting(t *testing.T) {
	called := 0
	apiHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error":"api-only"}`, http.StatusNotFound)
	})
	handler, err := api.NewWebHandler(apiHandler, fstest.MapFS{
		"index.html":         {Data: []byte("<html>Sillage</html>")},
		"assets/app-abcd.js": {Data: []byte("console.log('app')")},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, path string
		status       int
		body         string
	}{
		{"GET", "/", 200, "<html>Sillage</html>"},
		{"GET", "/videos/42", 200, "<html>Sillage</html>"},
		{"GET", "/unknown", 200, "<html>Sillage</html>"},
		{"GET", "/index.html", 200, "<html>Sillage</html>"},
		{"HEAD", "/videos/42", 200, ""},
		{"GET", "/assets/app-abcd.js", 200, "console.log"},
		{"GET", "/assets/missing.js", 404, "404"},
		{"GET", "/assets/missing", 404, "404"},
		{"GET", "/assets", 404, "404"},
		{"GET", "/data/sillage.db", 404, "404"},
		{"GET", "/../index.html", 404, "404"},
		{"GET", "/api", 404, "api-only"},
		{"GET", "/api/v1/unknown", 404, "api-only"},
		{"POST", "/videos/42", 405, "method not allowed"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.body) {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			if tc.method == "HEAD" && w.Body.Len() != 0 {
				t.Fatal("HEAD has a body")
			}
			if strings.Contains(w.Body.String(), "<html>") && w.Header().Get("Cache-Control") != "no-cache" {
				t.Fatal("index must revalidate")
			}
			if tc.path == "/assets/app-abcd.js" && !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
				t.Fatal("fingerprinted assets should be cached")
			}
		})
	}
	if called != 2 {
		t.Fatalf("API calls = %d", called)
	}
}

func TestWebRequiresBuild(t *testing.T) {
	if _, err := api.NewWebHandler(nil, fstest.MapFS{}); err == nil {
		t.Fatal("missing build accepted")
	}
}

func TestWebRootDoesNotExposeOutsideSymlinks(t *testing.T) {
	dir := t.TempDir()
	build := filepath.Join(dir, "web")
	if err := os.Mkdir(build, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(build, "index.html"), []byte("SPA"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.db"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../secret.db", filepath.Join(build, "secret.db")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(build)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	handler, err := api.NewWebHandler(nil, root.FS())
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/secret.db", nil))
	if w.Code != 404 || strings.Contains(w.Body.String(), "private") {
		t.Fatal(w.Code, w.Body.String())
	}
}
