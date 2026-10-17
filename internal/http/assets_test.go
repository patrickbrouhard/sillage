package http

import (
	"context"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/video"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type captureStub struct {
	a      asset.Asset
	err    error
	starts int
}

func (s *captureStub) Start(context.Context, video.VideoID, video.VideoSourceID, int64, string) (asset.Asset, error) {
	s.starts++
	return s.a, s.err
}
func (s *captureStub) Get(context.Context, int64) (asset.Asset, error)        { return s.a, s.err }
func (s *captureStub) ByRequest(context.Context, string) (asset.Asset, error) { return s.a, s.err }
func (s *captureStub) Open(context.Context, int64) (asset.Asset, asset.Content, error) {
	return s.a, nil, asset.ErrUnavailable
}

func TestCaptureRESTContract(t *testing.T) {
	source := video.VideoSourceID(2)
	timestamp := int64(123)
	secret := "private.png"
	stub := &captureStub{a: asset.Asset{ID: 3, VideoID: 1, SourceID: &source, TimestampMS: &timestamp, Type: "screenshot", Status: "pending", Path: &secret, CreatedAt: time.Now()}}
	router := NewRouter(nil, nil, nil, nil, nil, nil, nil, 0, stub)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	path := "/api/v1/videos/1/sources/2/captures"
	w := request("POST", path, `{"timestamp_ms":123,"request_id":"request1234567890"}`)
	if w.Code != 202 || w.Header().Get("Location") != "/api/v1/assets/3" || strings.Contains(w.Body.String(), "private.png") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{}`, `{"timestamp_ms":1.2}`, `{"timestamp_ms":2,"extra":1}`, `{"timestamp_ms":2}{}`} {
		if w := request("POST", path, body); w.Code != 400 {
			t.Fatalf("%s: %d", body, w.Code)
		}
	}
	if stub.starts != 1 {
		t.Fatal(stub.starts)
	}
	for _, path := range []string{"/api/v1/assets/3", "/api/v1/assets/requests/request1234567890"} {
		if w := request("GET", path, ""); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code)
		}
	}
	if w := request("GET", "/api/v1/assets/3/content", ""); w.Code != 409 {
		t.Fatal(w.Code)
	}
	stub.err = asset.ErrBusy
	if w := request("POST", path, `{"timestamp_ms":123,"request_id":"request1234567890"}`); w.Code != 503 {
		t.Fatal(w.Code)
	}
}
