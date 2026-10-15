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
