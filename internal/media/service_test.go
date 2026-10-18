package media_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type provider struct {
	gate    chan struct{}
	entered chan struct{}
	calls   atomic.Int32
	err     error
}

func (p *provider) Download(ctx context.Context, _ video.VideoSource, dir string) (media.Acquired, error) {
	p.calls.Add(1)
	if p.entered != nil {
		select {
		case p.entered <- struct{}{}:
		default:
		}
	}
	if p.gate != nil {
		select {
		case <-p.gate:
		case <-ctx.Done():
			return media.Acquired{}, ctx.Err()
		}
	}
	if p.err != nil {
		return media.Acquired{}, p.err
	}
	if err := os.WriteFile(filepath.Join(dir, "media.mp4"), []byte("complete"), 0600); err != nil {
		return media.Acquired{}, err
	}
	vc, ac, language := "h264", "aac", "fr-FR"
	width, height, fps := 1920, 1080, 29.97
	return media.Acquired{Format: "mp4", Size: 8, DurationMS: 10000,
		VideoCodec: &vc, AudioCodec: &ac, Width: &width, Height: &height, FPS: &fps, AudioLanguage: &language}, nil
}

func setup(t *testing.T, p *provider, timeout time.Duration, contexts ...context.Context) (*media.Service, *sqlite.MediaRepository, *filesystem.Media, video.Video, video.Video) {
	t.Helper()
	ctx := context.Background()
	if len(contexts) > 0 {
		ctx = contexts[0]
	}
	dir := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	videos := sqlite.NewVideoRepository(db)
	create := func(external string) video.Video {
		v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now().UTC(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: external, Title: external}}})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	v1, v2 := create("aaaaaaaaaaa"), create("bbbbbbbbbbb")
	repo := sqlite.NewMediaRepository(db)
	storage := filesystem.NewMedia(filepath.Join(dir, "media"))
	service, err := media.NewService(ctx, videos, repo, storage, p, timeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return service, repo, storage, v1, v2
}

func waitState(t *testing.T, s *media.Service, v video.Video, want string) media.State {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		state, err := s.Get(context.Background(), v.ID, v.Sources[0].ID)
		if err != nil {
			t.Fatal(err)
		}
		if state.Status == want {
			return state
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("state never became %s", want)
	return media.State{}
}

func TestDownloadConcurrencyAndRequestIndependence(t *testing.T) {
	p := &provider{gate: make(chan struct{}), entered: make(chan struct{}, 1)}
	s, repo, _, v, other := setup(t, p, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			state, err := s.Start(ctx, v.ID, v.Sources[0].ID)
			if err != nil || state.Status != "downloading" {
				t.Errorf("start %+v %v", state, err)
			}
		}()
	}
	wg.Wait()
	cancel()
	<-p.entered
	if _, err := s.Start(context.Background(), other.ID, other.Sources[0].ID); !errors.Is(err, media.ErrBusy) {
		t.Fatalf("busy: %v", err)
	}
	if _, err := s.Start(context.Background(), v.ID, other.Sources[0].ID); !errors.Is(err, video.ErrVideoSourceNotFound) {
		t.Fatalf("ownership: %v", err)
	}
	close(p.gate)
	state := waitState(t, s, v, "available")
	if p.calls.Load() != 1 {
		t.Fatalf("downloads=%d", p.calls.Load())
	}
	if again, err := s.Start(context.Background(), v.ID, v.Sources[0].ID); err != nil || again.File.ID != state.File.ID {
		t.Fatalf("existing %+v %v", again, err)
	}
	if err := s.Delete(context.Background(), other.ID, state.File.ID); !errors.Is(err, media.ErrNotFound) {
		t.Fatalf("foreign delete: %v", err)
	}
	if err := s.Delete(context.Background(), v.ID, state.File.ID); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, v, "not_downloaded")
	if files, err := repo.List(context.Background()); err != nil || len(files) != 0 {
		t.Fatalf("files %+v %v", files, err)
	}
	if err := s.Delete(context.Background(), v.ID, state.File.ID); err != nil {
		t.Fatal(err)
	}
}

func TestFailureTimeoutAndShutdown(t *testing.T) {
	for _, test := range []struct {
		name    string
		err     error
		timeout time.Duration
		close   bool
		want    string
	}{
		{"provider", media.ErrDownload, time.Minute, false, "download_failed"},
		{"timeout", nil, 20 * time.Millisecond, false, "download_timeout"},
		{"shutdown", nil, time.Minute, true, "download_interrupted"},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := &provider{err: test.err, entered: make(chan struct{}, 1)}
			if test.err == nil {
				p.gate = make(chan struct{})
			}
			s, repo, _, v, _ := setup(t, p, test.timeout)
			if _, err := s.Start(context.Background(), v.ID, v.Sources[0].ID); err != nil {
				t.Fatal(err)
			}
			<-p.entered
			if test.close {
				s.Close()
			}
			state := waitState(t, s, v, "failed")
			if state.ErrorCode != test.want {
				t.Fatalf("%+v", state)
			}
			if files, err := repo.List(context.Background()); err != nil || len(files) != 0 {
				t.Fatalf("%+v %v", files, err)
			}
		})
	}
}

type failingRepository struct {
	media.Repository
	commit bool
}

func (r failingRepository) Save(ctx context.Context, f media.File) (media.File, error) {
	if r.commit {
		if _, err := r.Repository.Save(ctx, f); err != nil {
			return media.File{}, err
		}
	}
	return media.File{}, errors.New("uncertain commit")
}

func TestPublicationFailureAndUncertainCommit(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "rollback", true: "committed"}[committed], func(t *testing.T) {
			dir := t.TempDir()
			var output bytes.Buffer
			logger, _ := logging.New(&output, "DEBUG", "json")
			ctx := logging.WithLogger(context.Background(), logger)
			db, err := sqlite.Open(ctx, filepath.Join(dir, "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			videos := sqlite.NewVideoRepository(db)
			v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now().UTC(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "aaaaaaaaaaa", Title: "test"}}})
			if err != nil {
				t.Fatal(err)
			}
			storage := filesystem.NewMedia(filepath.Join(dir, "media"))
			repo := sqlite.NewMediaRepository(db)
			s, err := media.NewService(ctx, videos, failingRepository{repo, committed}, storage, &provider{}, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			_, err = s.Start(ctx, v.ID, v.Sources[0].ID)
			if err != nil {
				t.Fatal(err)
			}
			want := "failed"
			if committed {
				want = "available"
			}
			state := waitState(t, s, v, want)
			s.Close()
			terminal := "download.finalization_uncertain"
			if committed {
				terminal = "download.completed"
			}
			if strings.Count(output.String(), terminal) != 1 || (committed && strings.Contains(output.String(), "download.failed")) {
				t.Fatal(output.String())
			}
			entries, err := os.ReadDir(filepath.Join(dir, "media"))
			if err != nil {
				t.Fatal(err)
			}
			count := 1
			if committed {
				count = 1
				if err := storage.Check(*state.File); err != nil {
					t.Fatal(err)
				}
			}
			if len(entries) != count {
				t.Fatalf("entries %v", entries)
			}
			// Un nouveau service oublie l'échec, mais retrouve le fichier durable.
			restarted, err := media.NewService(ctx, videos, repo, storage, &provider{}, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			want = "not_downloaded"
			if committed {
				want = "available"
			}
			waitState(t, restarted, v, want)
		})
	}
}

func TestMissingFileIsNotAbsenceAndCanBeExplicitlyRemoved(t *testing.T) {
	s, _, storage, v, _ := setup(t, &provider{}, time.Minute)
	_, err := s.Start(context.Background(), v.ID, v.Sources[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, v, "available")
	if err := storage.StageDelete(*state.File); err != nil {
		t.Fatal(err)
	}
	if err := storage.FinishDelete(*state.File); err != nil {
		t.Fatal(err)
	}
	missing, err := s.Get(context.Background(), v.ID, v.Sources[0].ID)
	if !errors.Is(err, media.ErrUnavailable) || missing.File == nil {
		t.Fatalf("%+v %v", missing, err)
	}
	if _, err := s.Start(context.Background(), v.ID, v.Sources[0].ID); !errors.Is(err, media.ErrUnavailable) {
		t.Fatal(err)
	}
	if err := s.Delete(context.Background(), v.ID, state.File.ID); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, v, "not_downloaded")
}

// finalizingStorage bloque le nettoyage après publication pour rendre la fenêtre concurrente déterministe.
type finalizingStorage struct {
	media.Storage
	entered chan struct{}
	release chan struct{}
}

func (s *finalizingStorage) Discard(stage string) error {
	close(s.entered)
	<-s.release
	return s.Storage.Discard(stage)
}

func TestAvailableWaitsForFinalization(t *testing.T) {
	// Réutiliser les repositories réels et intercepter seulement la frontière de finalisation.
	base, repo, storage, v, other := setup(t, &provider{}, time.Minute)
	base.Close()
	videos := fixedVideos{v, other}
	blocked := &finalizingStorage{Storage: storage, entered: make(chan struct{}), release: make(chan struct{})}
	service, err := media.NewService(context.Background(), videos, repo, blocked, &provider{}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			close(blocked.release)
		}
		service.Close()
	}()
	ctx := context.Background()
	if _, err := service.Start(ctx, v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	<-blocked.entered
	saved, err := repo.BySource(ctx, v.Sources[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := service.Get(ctx, v.ID, v.Sources[0].ID)
	if err != nil || state.Status != "downloading" || state.File != nil {
		t.Fatalf("%+v %v", state, err)
	}
	state, err = service.Start(ctx, v.ID, v.Sources[0].ID)
	if err != nil || state.Status != "downloading" {
		t.Fatalf("%+v %v", state, err)
	}
	if _, err := service.Start(ctx, other.ID, other.Sources[0].ID); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, v.ID, saved.ID); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
	close(blocked.release)
	released = true
	waitState(t, service, v, "available")
	if err := service.Delete(ctx, v.ID, saved.ID); err != nil {
		t.Fatal(err)
	}
}

// fixedVideos fournit uniquement les identités nécessaires au service testé.
type fixedVideos []video.Video

func (v fixedVideos) Get(_ context.Context, id video.VideoID) (video.Video, error) {
	for _, item := range v {
		if item.ID == id {
			return item, nil
		}
	}
	return video.Video{}, video.ErrVideoNotFound
}

func TestMediaAnomalyDoesNotPreventServiceCreation(t *testing.T) {
	base, repo, _, v, _ := setup(t, &provider{}, time.Minute)
	base.Close()
	root := filepath.Join(t.TempDir(), "media")
	if err := os.WriteFile(root, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	service, err := media.NewService(context.Background(), fixedVideos{v}, repo, filesystem.NewMedia(root), &provider{}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if _, err := service.Start(context.Background(), v.ID, v.Sources[0].ID); err == nil {
		t.Fatal("unavailable storage accepted")
	}
	if _, err := service.Get(context.Background(), v.ID, v.Sources[0].ID); err == nil {
		t.Fatal("unavailable storage reported absent")
	}
}

// TestDownloadPersistsTechnicalMetadata vérifie le passage fournisseur/service/SQLite.
func TestDownloadPersistsTechnicalMetadata(t *testing.T) {
	s, repo, _, v, _ := setup(t, &provider{}, time.Minute)
	if _, err := s.Start(context.Background(), v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, v, "available")
	file, err := repo.Get(context.Background(), state.File.ID)
	if err != nil || file.VideoCodec == nil || *file.VideoCodec != "h264" ||
		file.AudioCodec == nil || *file.AudioCodec != "aac" || file.Width == nil || *file.Width != 1920 ||
		file.Height == nil || *file.Height != 1080 || file.FPS == nil || *file.FPS != 29.97 ||
		file.AudioLanguage == nil || *file.AudioLanguage != "fr-FR" {
		t.Fatalf("%+v %v", file, err)
	}
}

func TestCaptureLeaseProtectsOnlyItsMedia(t *testing.T) {
	s, _, _, v, other := setup(t, &provider{}, time.Minute)
	ctx := context.Background()
	if _, err := s.Start(ctx, v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	state := waitState(t, s, v, "available")
	path, release, err := s.Borrow(ctx, v.ID, v.Sources[0].ID)
	if err != nil || path == "" {
		t.Fatalf("%s %v", path, err)
	}
	defer release()
	if err := s.Delete(ctx, v.ID, state.File.ID); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
	if _, _, err := s.Borrow(ctx, other.ID, v.Sources[0].ID); !errors.Is(err, video.ErrVideoSourceNotFound) {
		t.Fatal(err)
	}
	// Une capture n'empêche pas l'acquisition d'une autre source.
	if _, err := s.Start(ctx, other.ID, other.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	waitState(t, s, other, "available")
	release()
	release()
	if err := s.Delete(ctx, v.ID, state.File.ID); err != nil {
		t.Fatal(err)
	}
}

func TestOpenExactMediaReservesEveryReader(t *testing.T) {
	s, _, _, v, other := setup(t, &provider{}, time.Minute)
	ctx := context.Background()
	s.Start(ctx, v.ID, v.Sources[0].ID)
	state := waitState(t, s, v, "available")
	if _, _, err := s.Open(ctx, other.ID, state.File.ID); !errors.Is(err, media.ErrNotFound) {
		t.Fatal(err)
	}
	_, first, err := s.Open(ctx, v.ID, state.File.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	_, second, err := s.Open(ctx, v.ID, state.File.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	first.Close()
	first.Close()
	if err := s.Delete(ctx, v.ID, state.File.ID); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
	second.Close()
	if err := s.Delete(ctx, v.ID, state.File.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Open(ctx, v.ID, state.File.ID); !errors.Is(err, media.ErrNotFound) {
		t.Fatal(err)
	}
}
