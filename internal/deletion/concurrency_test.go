package deletion_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/deletion"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type blockedProvider struct {
	entered chan struct{}
	release chan struct{}
}

func (p blockedProvider) wait(ctx context.Context) error {
	close(p.entered)
	select {
	case <-p.release:
		return errors.New("injected failure")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p blockedProvider) Download(ctx context.Context, _ video.VideoSource, _ string) (media.Acquired, error) {
	return media.Acquired{}, p.wait(ctx)
}
func (p blockedProvider) Fetch(ctx context.Context, _ video.VideoSource) (transcript.Acquisition, error) {
	return transcript.Acquisition{}, p.wait(ctx)
}
func (p blockedProvider) Extract(ctx context.Context, _ video.VideoSource, _ string, _ int64, _ string) error {
	return p.wait(ctx)
}

func TestAcquisitionsReserveVideoUntilCompletion(t *testing.T) {
	for _, kind := range []string{"download", "capture", "transcript"} {
		t.Run(kind, func(t *testing.T) {
			ctx, db, root, repo := fixture(t)
			activity := &video.Activity{}
			videos := sqlite.NewVideoRepository(db)
			provider := blockedProvider{make(chan struct{}), make(chan struct{})}
			downloads, err := media.NewService(ctx, videos, sqlite.NewMediaRepository(db), filesystem.NewMedia(filepath.Join(root, "media")), provider, time.Minute, activity)
			if err != nil {
				t.Fatal(err)
			}
			defer downloads.Close()
			deletes := deletion.NewService(repo, &recordingStorage{}, activity)
			var captures *asset.Service
			var fetched chan error
			switch kind {
			case "download":
				if _, err := downloads.Start(ctx, 1, 1); err != nil {
					t.Fatal(err)
				}
			case "capture":
				captures, err = asset.NewService(ctx, videos, sqlite.NewAssetRepository(db), downloads, provider, filesystem.NewAssets(filepath.Join(root, "assets")), time.Minute, activity)
				if err != nil {
					t.Fatal(err)
				}
				defer captures.Close()
				if _, err := captures.Start(ctx, 1, 1, 500, "new-capture-request"); err != nil {
					t.Fatal(err)
				}
			case "transcript":
				service := transcript.NewService(videos, sqlite.NewTranscriptRepository(db), provider, filesystem.NewTranscripts(filepath.Join(root, "transcripts"), ytdlp.ParseJSON3), activity)
				fetched = make(chan error, 1)
				go func() { _, err := service.Fetch(ctx, 1, 1); fetched <- err }()
			}
			select {
			case <-provider.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("worker not started")
			}
			if _, err := deletes.Delete(ctx, 1); !errors.Is(err, video.ErrBusy) {
				t.Fatal(err)
			}
			// La réservation d'une vidéo ne bloque pas une autre identité.
			other, err := activity.Delete(2)
			if err != nil {
				t.Fatal(err)
			}
			other()
			close(provider.release)
			if captures != nil {
				captures.Close()
			}
			downloads.Close()
			if fetched != nil {
				<-fetched
			}
			deadline := time.Now().Add(time.Second)
			for {
				pending, err := deletes.Delete(ctx, 1)
				if !errors.Is(err, video.ErrBusy) {
					if err != nil || pending {
						t.Fatal(pending, err)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("reservation leaked")
				}
				time.Sleep(time.Millisecond)
			}
			count(t, db, "SELECT count(*) FROM videos WHERE id=1", 0)
		})
	}
}

func TestLocalReadersAndMediaDeletionRespectVideoReservation(t *testing.T) {
	ctx, db, root, _ := fixture(t)
	activity := &video.Activity{}
	service, err := media.NewService(ctx, sqlite.NewVideoRepository(db), sqlite.NewMediaRepository(db), filesystem.NewMedia(filepath.Join(root, "media")), nil, time.Minute, activity)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	_, content, err := service.Open(ctx, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := activity.Delete(1); !errors.Is(err, video.ErrBusy) {
		t.Fatal(err)
	}
	if err := content.Close(); err != nil {
		t.Fatal(err)
	}
	exclusive, err := activity.Delete(1)
	if err != nil {
		t.Fatal(err)
	}
	defer exclusive()
	if _, _, err := service.Open(ctx, 1, 1); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
	if _, err := service.Start(ctx, 1, 1); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, 1, 1); !errors.Is(err, media.ErrBusy) {
		t.Fatal(err)
	}
}
