package media_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
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
	return media.Acquired{Format: "mp4", Size: 8, DurationMS: 10000}, nil
}

func setup(t *testing.T, p *provider, timeout time.Duration) (*media.Service, *sqlite.MediaRepository, *filesystem.Media, video.Video, video.Video) {
	t.Helper()
	ctx := context.Background()
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
		{"provider", media.ErrAudio, time.Minute, false, "media_audio_ambiguous"},
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
			ctx := context.Background()
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
			entries, err := os.ReadDir(filepath.Join(dir, "media"))
			if err != nil {
				t.Fatal(err)
			}
			count := 0
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
	if err := storage.RemovePublished(state.File.Path); err != nil {
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
