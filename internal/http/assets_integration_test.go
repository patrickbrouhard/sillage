package http

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type absentMedia struct{}

func (absentMedia) Borrow(context.Context, video.VideoID, video.VideoSourceID) (string, func(), error) {
	return "", nil, media.ErrNotFound
}

type imageExtractor struct{}

func (imageExtractor) Extract(ctx context.Context, _ video.VideoSource, _ string, _ int64, stage string) error {
	logging.From(ctx).DebugContext(ctx, "Image extracted", "event", "test.extraction")
	f, err := os.Create(filepath.Join(stage, "frame.png"))
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, image.NewRGBA(image.Rect(0, 0, 4, 3)))
}

func TestAssetRESTPersistenceAndPNGContent(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "DEBUG", "json")
	ctx := logging.WithLogger(context.Background(), logger)
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
	router := WithLogging(logger, NewRouter(nil, nil, nil, nil, nil, nil, nil, 0, service))
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
	origin := w.Header().Get("X-Request-ID")
	// Ne pas utiliser le corps ni Location : simuler leur perte après l'acceptation.
	w = request("GET", "/api/v1/assets/requests/integration_0001", "")
	var recovered struct{ ID int64 }
	if err := json.Unmarshal(w.Body.Bytes(), &recovered); err != nil || w.Code != 200 || recovered.ID != 1 {
		t.Fatalf("recovery: %d %s %v", w.Code, w.Body, err)
	}
	recoveryRequest := w.Header().Get("X-Request-ID")
	if recoveryRequest == origin {
		t.Fatal("HTTP requests share an identity")
	}
	location := fmt.Sprintf("/api/v1/assets/%d", recovered.ID)
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
	service.Close()
	counts := map[string]int{}
	recoverySummaries := 0
	for _, row := range logRows(t, &output) {
		event := row["event"].(string)
		counts[event]++
		if event == "http.completed" && row["http_request_id"] == recoveryRequest {
			recoverySummaries++
			if row["asset_id"] != float64(1) || row["operation_id"] != "capture:1" ||
				row["route"] != "/api/v1/assets/requests/{request_id}" || row["level"] != "DEBUG" {
				t.Fatal(row)
			}
		}
		if event == "capture.started" || event == "capture.completed" || event == "test.extraction" {
			if row["origin_request_id"] != origin || row["operation_id"] != "capture:1" {
				t.Fatal(row)
			}
		}
	}
	if recoverySummaries != 1 || strings.Contains(output.String(), "integration_0001") {
		t.Fatal(output.String())
	}
	if counts["capture.started"] != 1 || counts["capture.completed"] != 1 || counts["test.extraction"] != 1 {
		t.Fatal(counts)
	}
}
