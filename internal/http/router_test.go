package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type serviceStub struct {
	add  func(context.Context, string) (video.AddVideoResult, error)
	get  func(context.Context, video.VideoID) (video.Video, error)
	list func(context.Context) ([]video.Video, error)
}

func (s serviceStub) AddVideo(ctx context.Context, url string) (video.AddVideoResult, error) {
	return s.add(ctx, url)
}
func (s serviceStub) GetVideo(ctx context.Context, id video.VideoID) (video.Video, error) {
	return s.get(ctx, id)
}
func (s serviceStub) ListVideos(ctx context.Context) ([]video.Video, error) { return s.list(ctx) }

func request(h http.Handler, method, path, body, contentType string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func assertError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body struct {
		Error struct {
			Code    string
			Message string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err, w.Body.String())
	}
	if w.Code != status || body.Error.Code != code || body.Error.Message == "" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %v %s", w.Code, w.Header(), w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private diagnostic") {
		t.Fatal("technical error leaked")
	}
}

func TestPostValidation(t *testing.T) {
	h := api.NewRouter(serviceStub{add: func(context.Context, string) (video.AddVideoResult, error) {
		t.Fatal("service called for invalid request")
		return video.AddVideoResult{}, nil
	}}, time.Second)
	for _, tc := range []struct {
		name, body, contentType string
		status                  int
		code                    string
	}{
		{"missing content type", "{}", "", 415, "unsupported_media_type"},
		{"wrong content type", "{}", "text/plain", 415, "unsupported_media_type"},
		{"malformed content type", "{}", "application/json; charset", 415, "unsupported_media_type"},
		{"empty", "", "application/json", 400, "bad_request"},
		{"null", "null", "application/json", 400, "bad_request"},
		{"array", "[]", "application/json", 400, "bad_request"},
		{"missing URL", "{}", "application/json", 400, "bad_request"},
		{"null URL", `{"url":null}`, "application/json", 400, "bad_request"},
		{"blank URL", `{"url":"  "}`, "application/json", 400, "bad_request"},
		{"numeric URL", `{"url":12}`, "application/json", 400, "bad_request"},
		{"unknown field", `{"url":"https://youtu.be/x","extra":1}`, "application/json", 400, "bad_request"},
		{"multiple values", `{"url":"https://youtu.be/x"} {}`, "application/json", 400, "bad_request"},
		{"trailing garbage", `{"url":"https://youtu.be/x"} x`, "application/json", 400, "bad_request"},
		{"oversized", `{"url":"` + strings.Repeat("x", 16384) + `"}`, "application/json", 413, "payload_too_large"},
		{"oversized whitespace", `{"url":"https://youtu.be/x"}` + strings.Repeat(" ", 16384), "application/json", 413, "payload_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertError(t, request(h, "POST", "/api/v1/videos", tc.body, tc.contentType), tc.status, tc.code)
		})
	}
}

func TestPostJSONParametersAndSizeBoundary(t *testing.T) {
	calls := 0
	h := api.NewRouter(serviceStub{add: func(ctx context.Context, url string) (video.AddVideoResult, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing application deadline")
		}
		if url != "https://youtu.be/x" {
			t.Fatalf("URL = %q", url)
		}
		return video.AddVideoResult{Video: video.Video{ID: 42}, Created: true}, nil
	}}, time.Minute)
	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "Application/JSON; charset=\"UTF-8\""} {
		body := `{"url":" https://youtu.be/x "}`
		body += strings.Repeat(" ", 16384-len(body))
		w := request(h, "POST", "/api/v1/videos", body, ct)
		if w.Code != 201 || w.Header().Get("Location") != "/api/v1/videos/42" {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	if calls != 3 {
		t.Fatal(calls)
	}
}

func TestErrors(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{video.ErrInvalidInput, 400, "bad_request"},
		{video.ErrVideoNotFound, 404, "video_not_found"},
		{video.ErrMetadataFetchFailed, 502, "metadata_fetch_failed"},
		{context.DeadlineExceeded, 504, "metadata_fetch_timeout"},
		{video.ErrMetadataProviderUnavailable, 500, "internal_error"},
		{errors.New("unexpected database failure"), 500, "internal_error"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			h := api.NewRouter(serviceStub{add: func(context.Context, string) (video.AddVideoResult, error) {
				return video.AddVideoResult{}, fmt.Errorf("private diagnostic: %w", tc.err)
			}}, time.Second)
			assertError(t, request(h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/x"}`, "application/json"), tc.status, tc.code)
		})
	}
	h := api.NewRouter(serviceStub{
		get: func(context.Context, video.VideoID) (video.Video, error) {
			return video.Video{}, video.ErrVideoNotFound
		},
		list: func(context.Context) ([]video.Video, error) { return nil, errors.New("private diagnostic") },
	}, time.Second)
	assertError(t, request(h, "GET", "/api/v1/videos/42", "", ""), 404, "video_not_found")
	assertError(t, request(h, "GET", "/api/v1/videos", "", ""), 500, "internal_error")
	for _, id := range []string{"0", "-1", "abc", "9223372036854775808"} {
		assertError(t, request(h, "GET", "/api/v1/videos/"+id, "", ""), 400, "bad_request")
	}
}

func TestDeadlineAndClientCancellation(t *testing.T) {
	h := api.NewRouter(serviceStub{add: func(ctx context.Context, _ string) (video.AddVideoResult, error) {
		<-ctx.Done()
		return video.AddVideoResult{}, fmt.Errorf("wrapped: %w", ctx.Err())
	}}, 10*time.Millisecond)
	assertError(t, request(h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/x"}`, "application/json"), 504, "metadata_fetch_timeout")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("POST", "/api/v1/videos", strings.NewReader(`{"url":"https://youtu.be/x"}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Body.Len() != 0 || len(w.Header()) != 0 {
		t.Fatalf("response to canceled client: %s", w.Body.String())
	}
}

type providerFunc func(context.Context, string) (video.VideoSource, error)

func (f providerFunc) Extract(ctx context.Context, url string) (video.VideoSource, error) {
	return f(ctx, url)
}

func TestLibraryEndToEnd(t *testing.T) {
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	calls := 0
	provider := providerFunc(func(context.Context, string) (video.VideoSource, error) {
		calls++
		return video.VideoSource{Provider: "youtube", ExternalID: "x", CanonicalURL: "https://youtu.be/x", Title: fmt.Sprintf("title %d", calls)}, nil
	})
	h := api.NewRouter(video.NewService(sqlite.NewVideoRepository(db), provider), time.Second)
	empty := request(h, "GET", "/api/v1/videos", "", "")
	if empty.Code != 200 || strings.TrimSpace(empty.Body.String()) != `{"videos":[]}` {
		t.Fatal(empty.Body.String())
	}
	created := request(h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/x"}`, "application/json")
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	duplicate := request(h, "POST", "/api/v1/videos", `{"url":"https://www.youtube.com/watch?v=x"}`, "application/json")
	detail := request(h, "GET", created.Header().Get("Location"), "", "")
	if duplicate.Code != 200 || detail.Code != 200 || duplicate.Header().Get("Location") != "" ||
		duplicate.Body.String() != created.Body.String() || detail.Body.String() != created.Body.String() {
		t.Fatalf("representations differ: %s / %s / %s", created.Body.String(), duplicate.Body.String(), detail.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 3 {
		t.Fatal(body)
	}
	date := body["created_at"].(string)
	if _, err := time.Parse(time.RFC3339Nano, date); err != nil || !strings.HasSuffix(date, "Z") {
		t.Fatal(date)
	}
	source := body["sources"].([]any)[0].(map[string]any)
	if len(source) != 9 || source["title"] != "title 1" {
		t.Fatal(source)
	}
	if _, ok := source["video_id"]; ok {
		t.Fatal("video_id exposed")
	}
	for _, key := range []string{"description", "creator", "duration_ms", "thumbnail_url"} {
		value, ok := source[key]
		if !ok || value != nil {
			t.Fatalf("%s = %v, present %v", key, value, ok)
		}
	}
	list := request(h, "GET", "/api/v1/videos", "", "")
	var library struct{ Videos []json.RawMessage }
	if err := json.Unmarshal(list.Body.Bytes(), &library); err != nil || list.Code != 200 || len(library.Videos) != 1 {
		t.Fatal(list.Body.String())
	}
	var listed map[string]any
	if err := json.Unmarshal(library.Videos[0], &listed); err != nil || !reflect.DeepEqual(body, listed) {
		t.Fatal(list.Body.String())
	}
}

func TestConcurrentHTTPAdds(t *testing.T) {
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "concurrent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	provider := providerFunc(func(context.Context, string) (video.VideoSource, error) {
		return video.VideoSource{Provider: "youtube", ExternalID: "x", CanonicalURL: "https://youtu.be/x", Title: "title"}, nil
	})
	h := api.NewRouter(video.NewService(sqlite.NewVideoRepository(db), provider), time.Second)
	results := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- request(h, "POST", "/api/v1/videos", `{"url":"https://youtu.be/x"}`, "application/json")
		}()
	}
	wg.Wait()
	a, b := <-results, <-results
	if a.Code+b.Code != 401 || a.Body.String() != b.Body.String() {
		t.Fatalf("%d %s / %d %s", a.Code, a.Body.String(), b.Code, b.Body.String())
	}
}
