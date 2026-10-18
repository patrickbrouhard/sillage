package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type mediaStub struct {
	state   media.State
	err     error
	starts  int
	deleted int64
}

func (s *mediaStub) Start(context.Context, video.VideoID, video.VideoSourceID) (media.State, error) {
	s.starts++
	return s.state, s.err
}
func (s *mediaStub) Get(context.Context, video.VideoID, video.VideoSourceID) (media.State, error) {
	return s.state, s.err
}
func (s *mediaStub) Delete(_ context.Context, _ video.VideoID, id int64) error {
	s.deleted = id
	return s.err
}

func TestMediaRESTContract(t *testing.T) {
	stub := &mediaStub{state: media.State{Status: "downloading"}}
	router := NewRouter(stub, nil, nil, nil, nil, nil, nil, 0)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	path := "/api/v1/videos/1/sources/2/download"
	w := request("POST", path, "")
	if w.Code != 202 || w.Header().Get("Location") != path {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w = request("POST", path, "{}"); w.Code != 400 || stub.starts != 1 {
		t.Fatalf("%d starts %d", w.Code, stub.starts)
	}
	if w = request("GET", "/api/v1/videos/0/sources/2/download", ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
	stub.state = media.State{Status: "available", File: &media.File{ID: 7, Path: "SECRET", Format: "mp4", Size: 100, DurationMS: 1000}}
	if w = request("POST", path, ""); w.Code != 200 || strings.Contains(w.Body.String(), "SECRET") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var legacy struct {
		File map[string]any `json:"media_file"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &legacy); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"video_codec", "audio_codec", "width", "height", "fps", "audio_language"} {
		value, exists := legacy.File[key]
		if !exists || value != nil {
			t.Fatalf("legacy %s=%v", key, value)
		}
	}
	vc, ac, lang := "av1", "opus", "fr-FR"
	width, height, fps := 1080, 1920, 29.97
	stub.state.File.VideoCodec, stub.state.File.AudioCodec, stub.state.File.AudioLanguage = &vc, &ac, &lang
	stub.state.File.Width, stub.state.File.Height, stub.state.File.FPS = &width, &height, &fps
	w = request("GET", path, "")
	if err := json.Unmarshal(w.Body.Bytes(), &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.File["video_codec"] != vc || legacy.File["audio_codec"] != ac ||
		legacy.File["width"] != float64(width) || legacy.File["height"] != float64(height) ||
		legacy.File["fps"] != fps || legacy.File["audio_language"] != lang {
		t.Fatal(legacy.File)
	}
	stub.err = media.ErrBusy
	if w = request("POST", path, ""); w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Fatal(w.Code)
	}
	stub.err = media.ErrUnavailable
	w = request("GET", path, "")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "local_media_unavailable") || strings.Contains(w.Body.String(), "SECRET") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	stub.err = nil
	stub.state = media.State{Status: "failed", ErrorCode: "media_duration_mismatch"}
	w = request("GET", path, "")
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 || body["status"] != "failed" {
		t.Fatalf("%s %v", w.Body, err)
	}
	if w = request(http.MethodDelete, "/api/v1/videos/1/media-files/7", ""); w.Code != 204 || stub.deleted != 7 {
		t.Fatal(w.Code)
	}
}

type mediaContentStub struct {
	mediaStub
	closes int
}
type testMediaContent struct {
	*strings.Reader
	close func()
}

func (c *testMediaContent) Close() error { c.close(); return nil }
func (s *mediaContentStub) Open(context.Context, video.VideoID, int64) (media.File, media.Content, error) {
	if s.err != nil {
		return media.File{}, nil, s.err
	}
	return media.File{Format: "webm"}, &testMediaContent{strings.NewReader("0123456789"), func() { s.closes++ }}, nil
}

func TestMediaContentHTTP(t *testing.T) {
	stub := &mediaContentStub{}
	router := NewRouter(stub, nil, nil, nil, nil, nil, nil, 0)
	for _, tc := range []struct {
		method, span, body string
		status             int
	}{
		{"GET", "", "0123456789", 200}, {"HEAD", "", "", 200},
		{"GET", "bytes=2-5", "2345", 206}, {"GET", "bytes=-3", "789", 206},
		{"GET", "bytes=7-", "789", 206}, {"GET", "bytes=20-", "", 416},
	} {
		t.Run(tc.method+tc.span, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/api/v1/videos/1/media-files/2/content", nil)
			r.Header.Set("Range", tc.span)
			w := httptest.NewRecorder()
			before := stub.closes
			router.ServeHTTP(w, r)
			if w.Code != tc.status || (tc.status != 416 && w.Body.String() != tc.body) {
				t.Fatalf("%d %q", w.Code, w.Body.String())
			}
			if stub.closes != before+1 {
				t.Fatal("content not closed")
			}
			if tc.status == 206 && w.Header().Get("Content-Range") == "" {
				t.Fatal("missing range")
			}
			if tc.status == 200 && w.Header().Get("Content-Length") != "10" {
				t.Fatal(w.Header())
			}
		})
	}
	for _, tc := range []struct {
		err    error
		status int
	}{
		{media.ErrNotFound, 404}, {media.ErrUnavailable, 409}, {video.ErrVideoNotFound, 404},
	} {
		stub.err = tc.err
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/videos/1/media-files/2/content", nil))
		if w.Code != tc.status {
			t.Fatal(w.Code)
		}
	}
}
