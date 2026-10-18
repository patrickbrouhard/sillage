package asset_test

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type localMedia struct {
	path     string
	err      error
	released atomic.Bool
}

func (l *localMedia) Borrow(context.Context, video.VideoID, video.VideoSourceID) (string, func(), error) {
	if l.path == "" {
		return "", nil, l.err
	}
	return l.path, func() { l.released.Store(true) }, nil
}

type extractor func(context.Context, video.VideoSource, string, int64, string) error

func (e extractor) Extract(ctx context.Context, v video.VideoSource, p string, t int64, s string) error {
	return e(ctx, v, p, t, s)
}

func writePNG(stage string) error {
	f, err := os.Create(filepath.Join(stage, "frame.png"))
	if err != nil {
		return err
	}
	defer f.Close()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	return png.Encode(f, img)
}

func setup(t *testing.T, local *localMedia, extract extractor, contexts ...context.Context) (*asset.Service, *sqlite.AssetRepository, video.Video, *filesystem.Assets) {
	t.Helper()
	root := t.TempDir()
	db, err := sqlite.Open(context.Background(), filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(context.Background(), video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "abcdefghijk", Title: "test"}}})
	if err != nil {
		t.Fatal(err)
	}
	repo := sqlite.NewAssetRepository(db)
	storage := filesystem.NewAssets(filepath.Join(root, "assets"))
	ctx := context.Background()
	if len(contexts) > 0 {
		ctx = contexts[0]
	}
	service, err := asset.NewService(ctx, videos, repo, local, extract, storage, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return service, repo, v, storage
}

func waitAsset(t *testing.T, s *asset.Service, id int64) asset.Asset {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		a, err := s.Get(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if a.Status != "pending" {
			return a
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("capture still pending")
	return asset.Asset{}
}

func TestCaptureIdentityConcurrencyAndRequestIndependence(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(gate) })
	var calls atomic.Int32
	s, repo, v, storage := setup(t, &localMedia{err: media.ErrNotFound}, func(ctx context.Context, _ video.VideoSource, _ string, _ int64, stage string) error {
		calls.Add(1)
		select {
		case <-gate:
			return writePNG(stage)
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	a, err := s.Start(ctx, v.ID, v.Sources[0].ID, 1234, "request_000000001")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	same, err := s.Start(context.Background(), v.ID, v.Sources[0].ID, 1234, a.RequestID)
	if err != nil || same.ID != a.ID {
		t.Fatalf("retry: %+v %v", same, err)
	}
	if _, err := s.Start(context.Background(), v.ID, v.Sources[0].ID, 1235, a.RequestID); !errors.Is(err, asset.ErrRequestConflict) {
		t.Fatal(err)
	}
	if _, err := s.Start(context.Background(), v.ID, v.Sources[0].ID, 1234, "request_000000002"); !errors.Is(err, asset.ErrBusy) {
		t.Fatal(err)
	}
	once.Do(func() { close(gate) })
	a = waitAsset(t, s, a.ID)
	if a.Status != "available" || calls.Load() != 1 {
		t.Fatalf("%+v calls=%d", a, calls.Load())
	}
	content, err := storage.Open(a)
	if err != nil {
		t.Fatal(err)
	}
	content.Close()
	second, err := s.Start(context.Background(), v.ID, v.Sources[0].ID, 1234, "request_000000002")
	if err != nil || second.ID == a.ID {
		t.Fatalf("new request: %+v %v", second, err)
	}
	waitAsset(t, s, second.ID)
	restored, err := repo.ByRequest(context.Background(), a.RequestID)
	if err != nil || restored.ID != a.ID {
		t.Fatal(err)
	}
}

func TestFallbackOnlyForExtraction(t *testing.T) {
	for _, test := range []struct {
		name    string
		failure error
		want    int32
		status  string
	}{
		{"decode", asset.ErrExtract, 2, "available"},
		{"disk", errors.New("disk full"), 1, "failed"},
		{"shutdown", context.Canceled, 1, "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			local := &localMedia{path: "local"}
			s, _, v, _ := setup(t, local, func(_ context.Context, _ video.VideoSource, path string, _ int64, stage string) error {
				calls.Add(1)
				if path != "" {
					return test.failure
				}
				return writePNG(stage)
			})
			a, err := s.Start(context.Background(), v.ID, v.Sources[0].ID, 0, "request_fallback01")
			if err != nil {
				t.Fatal(err)
			}
			a = waitAsset(t, s, a.ID)
			if a.Status != test.status || calls.Load() != test.want || !local.released.Load() {
				t.Fatalf("%+v calls=%d released=%v", a, calls.Load(), local.released.Load())
			}
		})
	}
}

func TestShutdownAndInterruptedIntent(t *testing.T) {
	s, repo, v, _ := setup(t, &localMedia{err: media.ErrNotFound}, func(ctx context.Context, _ video.VideoSource, _ string, _ int64, _ string) error {
		<-ctx.Done()
		return ctx.Err()
	})
	a, err := s.Start(context.Background(), v.ID, v.Sources[0].ID, 1, "request_shutdown1")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	a, err = repo.Get(context.Background(), a.ID)
	if err != nil || a.Status != "failed" || a.ErrorCode != "capture_interrupted" {
		t.Fatalf("%+v %v", a, err)
	}
	source := v.Sources[0].ID
	timestamp := int64(9)
	pending, err := repo.Create(context.Background(), asset.Asset{VideoID: v.ID, SourceID: &source, TimestampMS: &timestamp, Type: "screenshot", RequestID: "request_abandoned", CreatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending, err = repo.Get(context.Background(), pending.ID)
	if err != nil || pending.Status != "failed" {
		t.Fatalf("%+v %v", pending, err)
	}
}

// uncertainRepository simule une réponse SQL perdue avant ou après COMMIT.
type uncertainRepository struct {
	asset.Repository
	committed bool
	calls     int
}

func (r *uncertainRepository) Finish(ctx context.Context, id int64, status string, path *string, size int64, code string) error {
	r.calls++
	if r.calls == 1 {
		if r.committed {
			if err := r.Repository.Finish(ctx, id, status, path, size, code); err != nil {
				return err
			}
		}
		return errors.New("uncertain SQL commit")
	}
	return r.Repository.Finish(ctx, id, status, path, size, code)
}

type fixedVideo struct{ value video.Video }

func (v fixedVideo) Get(context.Context, video.VideoID) (video.Video, error) { return v.value, nil }

func TestPublishedPNGSurvivesUncertainSQLFinalization(t *testing.T) {
	for _, committed := range []bool{false, true} {
		name := "before_commit"
		if committed {
			name = "after_commit"
		}
		t.Run(name, func(t *testing.T) {
			var output bytes.Buffer
			logger, _ := logging.New(&output, "DEBUG", "json")
			ctx := logging.WithLogger(context.Background(), logger)
			original, repo, v, storage := setup(t, &localMedia{}, nil)
			original.Close()
			uncertain := &uncertainRepository{Repository: repo, committed: committed}
			service, err := asset.NewService(ctx, fixedVideo{v}, uncertain,
				&localMedia{err: media.ErrNotFound},
				extractor(func(_ context.Context, _ video.VideoSource, _ string, _ int64, stage string) error {
					return writePNG(stage)
				}),
				storage, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			defer service.Close()
			a, err := service.Start(context.Background(), v.ID, v.Sources[0].ID, 500, "request_uncertain")
			if err != nil {
				t.Fatal(err)
			}
			a = waitAsset(t, service, a.ID)
			service.Close()
			terminal := "capture.failed"
			if committed {
				terminal = "capture.completed"
			}
			if strings.Count(output.String(), terminal) != 1 || (committed && strings.Contains(output.String(), "capture.failed")) {
				t.Fatal(output.String())
			}
			want := "failed"
			if committed {
				want = "available"
			}
			if a.Status != want || a.Path == nil {
				t.Fatalf("unexpected final state: %+v", a)
			}
			content, err := storage.Open(a)
			if err != nil {
				t.Fatalf("published PNG lost: %v", err)
			}
			defer content.Close()
			if _, err := png.Decode(content); err != nil {
				t.Fatal(err)
			}
		})
	}
}
