package http

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type absentMedia struct{}

func (absentMedia) Borrow(context.Context, video.VideoID, video.VideoSourceID) (string, func(), error) {
	return "", nil, media.ErrNotFound
}

type imageExtractor struct{}

func (imageExtractor) Extract(_ context.Context, _ video.VideoSource, _ string, _ int64, stage string) error {
	f, err := os.Create(filepath.Join(stage, "frame.png"))
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, image.NewRGBA(image.Rect(0, 0, 4, 3)))
}

func TestAssetRESTPersistenceAndPNGContent(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "abcdefghijk", Title: "test"}}})
	if err != nil {
		t.Fatal(err)
	}
	service, err := asset.NewService(ctx, videos, sqlite.NewAssetRepository(db), absentMedia{}, imageExtractor{}, filesystem.NewAssets(filepath.Join(root, "assets")), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	router := NewRouter(nil, nil, nil, nil, nil, nil, nil, 0, service)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	// Les IDs de cette base neuve sont connus, mais la source est vérifiée par le service réel.
	if v.ID != 1 || v.Sources[0].ID != 1 {
		t.Fatal(v)
	}
	body := `{"timestamp_ms":123,"request_id":"integration_0001"}`
	w := request("POST", "/api/v1/videos/1/sources/1/captures", body)
	if w.Code != 202 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	location := w.Header().Get("Location")
	deadline := time.Now().Add(3 * time.Second)
	for {
		w = request("GET", location, "")
		var value struct{ Status string }
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		if value.Status == "available" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(w.Body)
		}
		time.Sleep(time.Millisecond)
	}
	w = request("GET", location+"/content", "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	img, err := png.Decode(w.Body)
	if err != nil || img.Bounds().Dx() != 4 {
		t.Fatalf("%v %v", img, err)
	}
	w = request("POST", "/api/v1/videos/1/sources/1/captures", body)
	if w.Code != 200 || w.Header().Get("Location") != location {
		t.Fatalf("recovery %d %s", w.Code, w.Body)
	}
	var count int
	db.QueryRow("SELECT count(*) FROM assets").Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
}
