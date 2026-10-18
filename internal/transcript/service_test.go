package transcript_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type providerFunc func(context.Context, video.VideoSource) (transcript.Acquisition, error)

func (f providerFunc) Fetch(ctx context.Context, s video.VideoSource) (transcript.Acquisition, error) {
	return f(ctx, s)
}

func acquisition(t *testing.T, text string) transcript.Acquisition {
	t.Helper()
	raw := []byte(fmt.Sprintf(`{"events":[{"tStartMs":0,"segs":[{"utf8":%q}]}]}`, text))
	content, err := ytdlp.ParseJSON3(raw)
	if err != nil {
		t.Fatal(err)
	}
	return transcript.Acquisition{Language: "en", Content: content, Source: raw}
}

func TestAcquisitionLifecycle(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "INFO", "json")
	ctx := logging.WithLogger(context.Background(), logger)
	defer func() {
		if strings.Count(output.String(), "transcript.acquired") != 2 || strings.Contains(output.String(), "first") || strings.Contains(output.String(), "second") {
			t.Fatal(output.String())
		}
	}()
	root := t.TempDir()
	path := filepath.Join(root, "sillage.db")
	db, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { db.Close() }()
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "abc", Title: "Title"}}})
	if err != nil {
		t.Fatal(err)
	}
	repo := sqlite.NewTranscriptRepository(db)
	snapshots := filesystem.NewTranscripts(filepath.Join(root, "snapshots"), ytdlp.ParseJSON3)
	current := acquisition(t, "first")
	var failure error
	calls := 0
	provider := providerFunc(func(context.Context, video.VideoSource) (transcript.Acquisition, error) {
		calls++
		return current, failure
	})
	service := transcript.NewService(videos, repo, provider, snapshots)
	source := v.Sources[0].ID
	if _, err := service.Get(ctx, v.ID, source); !errors.Is(err, transcript.ErrNotFound) {
		t.Fatal(err)
	}
	for _, ids := range [][2]int64{{0, int64(source)}, {int64(v.ID), 0}, {999, int64(source)}, {int64(v.ID), 999}} {
		if _, err := service.Fetch(ctx, video.VideoID(ids[0]), video.VideoSourceID(ids[1])); err == nil {
			t.Fatal("accepted invalid ownership")
		}
	}
	if calls != 0 {
		t.Fatal("remote call before identity validation")
	}
	failure = transcript.ErrFetchFailed
	if _, err := service.Fetch(ctx, v.ID, source); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if _, err := repo.Latest(ctx, source); !errors.Is(err, transcript.ErrNotFound) {
		t.Fatal(err)
	}
	failure = nil
	first, err := service.Fetch(ctx, v.ID, source)
	if err != nil {
		t.Fatal(err)
	}
	current = acquisition(t, "second")
	second, err := service.Fetch(ctx, v.ID, source)
	if err != nil || first.Transcript.ID != second.Transcript.ID || first.Transcript.LocalPath == second.Transcript.LocalPath {
		t.Fatalf("%#v %v", second, err)
	}
	// Un ancien lecteur peut encore ouvrir le fichier lu avant le rafraîchissement.
	old, err := snapshots.Read(ctx, first.Transcript.LocalPath)
	if err != nil || old.PlainText() != "first" {
		t.Fatal(old, err)
	}
	failure = transcript.ErrFetchFailed
	if _, err := service.Fetch(ctx, v.ID, source); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	got, err := service.Get(ctx, v.ID, source)
	if err != nil || !reflect.DeepEqual(got, second) {
		t.Fatalf("%#v %v", got, err)
	}
	// L'échec SQL après publication ne remplace pas le chemin courant.
	if _, err := db.Exec(`CREATE TRIGGER reject_refresh BEFORE UPDATE ON transcripts BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	failure = nil
	if _, err := service.Fetch(ctx, v.ID, source); err == nil {
		t.Fatal("SQL failure ignored")
	}
	got, err = service.Get(ctx, v.ID, source)
	if err != nil || !reflect.DeepEqual(got, second) {
		t.Fatal(got, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	// Un provider nil prouve que GET ne consulte jamais la source distante.
	service = transcript.NewService(sqlite.NewVideoRepository(db), sqlite.NewTranscriptRepository(db), nil, snapshots)
	got, err = service.Get(ctx, v.ID, source)
	if err != nil || !reflect.DeepEqual(got, second) {
		t.Fatal(got, err)
	}
	snapshotPath := filepath.Join(root, "snapshots", second.Transcript.LocalPath)
	if err := os.WriteFile(snapshotPath, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, v.ID, source); err == nil || errors.Is(err, transcript.ErrNotFound) || errors.Is(err, transcript.ErrFetchFailed) {
		t.Fatalf("corruption misclassified: %v", err)
	}
	if err := os.Remove(snapshotPath); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, v.ID, source); err == nil {
		t.Fatal("missing snapshot accepted")
	}
	if _, err := db.Exec("DROP TRIGGER reject_refresh"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE transcripts SET local_path = NULL"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, v.ID, source); err == nil || errors.Is(err, transcript.ErrNotFound) {
		t.Fatal(err)
	}
}

func TestConcurrentAcquisitions(t *testing.T) {
	for _, differentLanguages := range []bool{false, true} {
		t.Run(fmt.Sprintf("different_languages_%t", differentLanguages), func(t *testing.T) {
			testConcurrentAcquisitions(t, differentLanguages)
		})
	}
}

// testConcurrentAcquisitions vérifie les snapshots distincts et l'identité par langue.
func testConcurrentAcquisitions(t *testing.T, differentLanguages bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "sillage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "abc", Title: "Title"}}})
	if err != nil {
		t.Fatal(err)
	}
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	results := make(chan transcript.Result, 2)
	failures := make(chan error, 2)
	repo := sqlite.NewTranscriptRepository(db)
	snapshots := filesystem.NewTranscripts(filepath.Join(root, "snapshots"), ytdlp.ParseJSON3)
	for _, text := range []string{"first", "second"} {
		content := acquisition(t, text)
		if differentLanguages && text == "second" {
			content.Language = "fr"
		}
		provider := providerFunc(func(ctx context.Context, _ video.VideoSource) (transcript.Acquisition, error) {
			arrived <- struct{}{}
			select {
			case <-release:
				return content, nil
			case <-ctx.Done():
				return transcript.Acquisition{}, ctx.Err()
			}
		})
		service := transcript.NewService(videos, repo, provider, snapshots)
		go func() { result, err := service.Fetch(ctx, v.ID, v.Sources[0].ID); results <- result; failures <- err }()
	}
	for range 2 {
		select {
		case <-arrived:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	close(release)
	a, b := <-results, <-results
	for range 2 {
		if err := <-failures; err != nil {
			t.Fatal(err)
		}
	}
	if (a.Transcript.ID != b.Transcript.ID) != differentLanguages || a.Transcript.LocalPath == b.Transcript.LocalPath {
		t.Fatal(a, b)
	}
	storedVideo, err := videos.Get(ctx, v.ID)
	if err != nil || storedVideo.Sources[0].OriginalAudioLanguage != "" {
		t.Fatalf("audio language changed: %#v %v", storedVideo, err)
	}
	got, err := transcript.NewService(videos, repo, nil, snapshots).Get(ctx, v.ID, v.Sources[0].ID)
	if err != nil || (!reflect.DeepEqual(got, a) && !reflect.DeepEqual(got, b)) {
		t.Fatal(got, err)
	}
}

func TestAcquisitionPreservesIndependentAudioLanguage(t *testing.T) {
	for _, audioLanguage := range []string{"", "en", "en-US"} {
		t.Run("audio_"+audioLanguage, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			db, err := sqlite.Open(ctx, filepath.Join(root, "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			videos := sqlite.NewVideoRepository(db)
			v, err := videos.Create(ctx, video.Video{
				CreatedAt: time.Now(),
				Sources: []video.VideoSource{{
					Provider:              "youtube",
					ExternalID:            "abc",
					Title:                 "Test",
					OriginalAudioLanguage: audioLanguage,
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			current := acquisition(t, "original")
			var failure error
			service := transcript.NewService(
				videos,
				sqlite.NewTranscriptRepository(db),
				providerFunc(func(context.Context, video.VideoSource) (transcript.Acquisition, error) {
					return current, failure
				}),
				filesystem.NewTranscripts(filepath.Join(root, "snapshots"), ytdlp.ParseJSON3),
			)
			first, err := service.Fetch(ctx, v.ID, v.Sources[0].ID)
			if err != nil {
				t.Fatal(err)
			}
			current.Language = "fr"
			second, err := service.Fetch(ctx, v.ID, v.Sources[0].ID)
			if err != nil || second.Transcript.ID == first.Transcript.ID {
				t.Fatalf("%#v %v", second, err)
			}
			third, err := service.Fetch(ctx, v.ID, v.Sources[0].ID)
			if err != nil || third.Transcript.ID != second.Transcript.ID {
				t.Fatalf("%#v %v", third, err)
			}
			failure = transcript.ErrSelectionAmbiguous
			if _, err := service.Fetch(ctx, v.ID, v.Sources[0].ID); !errors.Is(err, failure) {
				t.Fatal(err)
			}
			got, err := service.Get(ctx, v.ID, v.Sources[0].ID)
			if err != nil || !reflect.DeepEqual(got, third) {
				t.Fatalf("%#v %v", got, err)
			}
			stored, err := videos.Get(ctx, v.ID)
			if err != nil || stored.Sources[0].OriginalAudioLanguage != audioLanguage {
				t.Fatalf("%#v %v", stored, err)
			}
		})
	}
}

func TestFailedPublicationAndCancellationDoNotPersist(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "sillage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{
		CreatedAt: time.Now(),
		Sources:   []video.VideoSource{{Provider: "youtube", ExternalID: "abc", Title: "Title"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	repo := sqlite.NewTranscriptRepository(db)
	blocked := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	content := acquisition(t, "valid text")
	provider := providerFunc(func(context.Context, video.VideoSource) (transcript.Acquisition, error) {
		return content, nil
	})
	service := transcript.NewService(videos, repo, provider, filesystem.NewTranscripts(blocked, ytdlp.ParseJSON3))
	if _, err := service.Fetch(ctx, v.ID, v.Sources[0].ID); err == nil || errors.Is(err, transcript.ErrFetchFailed) {
		t.Fatalf("local publication failure: %v", err)
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	provider = providerFunc(func(context.Context, video.VideoSource) (transcript.Acquisition, error) {
		cancel()
		return content, nil
	})
	service = transcript.NewService(videos, repo, provider, nil)
	if _, err := service.Fetch(cancelCtx, v.ID, v.Sources[0].ID); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := repo.Latest(ctx, v.Sources[0].ID); !errors.Is(err, transcript.ErrNotFound) {
		t.Fatalf("failed acquisition created a row: %v", err)
	}
}
