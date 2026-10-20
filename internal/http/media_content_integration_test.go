package http

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestMediaContentRealStorageAndDisconnectedReader(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "abcdefghijk", Title: "test"}}})
	if err != nil {
		t.Fatal(err)
	}
	other, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "12345678901", Title: "other"}}})
	if err != nil {
		t.Fatal(err)
	}
	storage := filesystem.NewMedia(filepath.Join(dir, "media"))
	if err := storage.Recover(ctx, nil); err != nil {
		t.Fatal(err)
	}
	stage, err := storage.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Discard(stage)
	raw, err := os.Create(filepath.Join(stage, "media.webm"))
	if err != nil {
		t.Fatal(err)
	}
	// Un fichier sparse suffisamment grand empêche le socket de terminer avant l'abandon.
	if err := raw.Truncate(64 * 1024 * 1024); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.WriteAt([]byte("0123456789"), 0); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	acquired := media.Acquired{Format: "webm", Size: 64 * 1024 * 1024, DurationMS: 10000}
	name, err := storage.Publish(ctx, stage, acquired)
	if err != nil {
		t.Fatal(err)
	}
	repo := sqlite.NewMediaRepository(db)
	f, err := repo.Save(ctx, media.File{VideoID: v.ID, OriginSourceID: &v.Sources[0].ID, Path: name, Format: "webm", Size: acquired.Size, DurationMS: 10000, AddedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	service, err := media.NewService(ctx, videos, repo, storage, nil, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	server := httptest.NewServer(NewRouter(service, nil, nil, nil, nil, nil, nil, 0))
	defer server.Close()
	url := fmt.Sprintf("%s/api/v1/videos/%d/media-files/%d/content", server.URL, v.ID, f.ID)
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Head(url)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || response.ContentLength != f.Size {
		t.Fatal(response.StatusCode, response.ContentLength)
	}
	for _, owner := range []video.VideoID{v.ID, other.ID} {
		request, _ := http.NewRequest("GET", fmt.Sprintf("%s/api/v1/videos/%d/media-files/%d/content", server.URL, owner, f.ID), nil)
		request.Header.Set("Range", "bytes=2-5")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if owner == v.ID && (response.StatusCode != 206 || string(body) != "2345") {
			t.Fatalf("%d %q", response.StatusCode, body)
		}
		if owner == other.ID && response.StatusCode != 404 {
			t.Fatal(response.StatusCode)
		}
	}
	response, err = client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if _, err := io.ReadFull(response.Body, make([]byte, 1024)); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, v.ID, f.ID); !errors.Is(err, media.ErrBusy) {
		t.Fatalf("active request: %v", err)
	}
	response.Body.Close()
	// La réservation est libérée après l'erreur d'écriture causée par la déconnexion.
	deadline := time.Now().Add(3 * time.Second)
	for {
		err = service.Delete(ctx, v.ID, f.ID)
		if err == nil {
			break
		}
		if !errors.Is(err, media.ErrBusy) || time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	response, err = client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal(response.StatusCode)
	}
}
