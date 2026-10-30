package deletion_test

import (
	"context"
	"database/sql"
	"errors"
	"github.com/patrickbrouhard/sillage/internal/note"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/deletion"
	"github.com/patrickbrouhard/sillage/internal/video"
)

const mediaPath = "media-00000000000000000000000000000001.webm"
const assetPath = "capture-1-100ms-00000000000000000000000000000001.png"

func fixture(t *testing.T) (context.Context, *sql.DB, string, *sqlite.DeletionRepository) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	// Deux vidéos, plusieurs sources, des entités partagées et tous les états d'assets.
	_, err = db.Exec(`
 INSERT INTO videos (id, created_at) VALUES (1, '2026-10-30T00:00:00.000Z'), (2, '2026-10-30T00:00:00.000Z');
 INSERT INTO persons (id, name) VALUES (1, 'Person');
 INSERT INTO publishers (id, provider, external_id, person_id) VALUES (1, 'youtube', 'publisher', 1);
 INSERT INTO video_sources (id, video_id, provider, external_id, title, publisher_id)
 VALUES (1, 1, 'youtube', 'one', 'Deleted', 1), (2, 1, 'youtube', 'two', 'Second', 1), (3, 2, 'youtube', 'three', 'Keep', 1);
 INSERT INTO notes (video_id, content_md, created_at, updated_at) VALUES
 (1, 'delete', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z'),
 (2, '![shared](/api/v1/assets/1/content)', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z');
 INSERT INTO tags (id, name, identity_key) VALUES (1, 'tag', 'tag');
 INSERT INTO video_tags VALUES (1,1), (2,1);
 INSERT INTO video_persons VALUES (1,1), (2,1);
 INSERT INTO publisher_tags VALUES (1,1);
 INSERT INTO person_tags VALUES (1,1);
 INSERT INTO playback_progress VALUES (1,100), (2,200), (3,300);
 INSERT INTO transcripts (video_source_id, language, provenance, local_path, last_fetched_at)
 VALUES (1,'en','youtube_auto','snapshot-1.json3','2026-10-30T00:00:00.000Z'),
 (2,'fr','youtube_auto','snapshot-2.json3','2026-10-30T00:00:00.000Z');
 INSERT INTO media_files (video_id, path, format, size, duration_ms, added_at)
 VALUES (1,'media-00000000000000000000000000000001.webm','webm',1,1000,'2026-10-30T00:00:00.000Z');
 INSERT INTO assets (id,video_id,source_id,timestamp_ms,type,status,path,size,request_id,created_at)
 VALUES (1,1,1,100,'screenshot','failed','capture-1-100ms-00000000000000000000000000000001.png',1,'failed','2026-10-30T00:00:00.000Z'),
 (2,1,2,200,'screenshot','pending',NULL,0,'pending','2026-10-30T00:00:00.000Z'),
 (3,1,2,300,'screenshot','available','capture-3-300ms-00000000000000000000000000000003.png',1,'available','2026-10-30T00:00:00.000Z');
 `)
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlite.RebuildSearch(ctx, db); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"media/" + mediaPath, "assets/" + assetPath, "transcripts/snapshot-1.json3", "transcripts/snapshot-2.json3", "transcripts/snapshot-999.json3"} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return ctx, db, root, sqlite.NewDeletionRepository(db)
}

func count(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil || got != want {
		t.Fatalf("%s: got %d want %d: %v", query, got, want, err)
	}
}

func TestDeletePreservesSharedKnowledgeAndReplaysManifest(t *testing.T) {
	ctx, db, root, repo := fixture(t)
	if err := repo.Delete(ctx, 1); err != nil {
		t.Fatal(err)
	}
	files, exists, err := repo.Pending(ctx, 1)
	if err != nil || !exists || len(files) != 5 {
		t.Fatalf("%v %v %v", files, exists, err)
	}
	for _, table := range []string{"videos", "video_sources", "notes", "video_tags", "video_persons", "playback_progress", "video_search", "tags", "persons", "publishers", "publisher_tags", "person_tags"} {
		count(t, db, "SELECT count(*) FROM "+table, 1)
	}
	for _, table := range []string{"assets", "media_files", "transcripts"} {
		count(t, db, "SELECT count(*) FROM "+table, 0)
	}
	var note string
	if err := db.QueryRow("SELECT content_md FROM notes WHERE video_id=2").Scan(&note); err != nil || note != "![shared](/api/v1/assets/1/content)" {
		t.Fatal(note, err)
	}
	// L'interruption après commit laisse les octets ; Recover retrouve la preuve durable.
	if _, err := os.Stat(filepath.Join(root, "media", mediaPath)); err != nil {
		t.Fatal(err)
	}
	// Une nouvelle connexion démontre que la reprise ne dépend d'aucune mémoire du service.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = sqlite.Open(ctx, filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo = sqlite.NewDeletionRepository(db)
	service := deletion.NewService(repo, filesystem.NewPurge(filepath.Join(root, "media"), filepath.Join(root, "assets"), filepath.Join(root, "transcripts")), &video.Activity{})
	if err := service.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"media/" + mediaPath, "assets/" + assetPath, "transcripts/snapshot-1.json3", "transcripts/snapshot-2.json3"} {
		if _, err := os.Stat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal(name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "transcripts/snapshot-999.json3")); err != nil {
		t.Fatal("orphan removed", err)
	}
	for range 2 {
		pending, err := service.Delete(ctx, 1)
		if err != nil || pending {
			t.Fatal(pending, err)
		}
	}
	count(t, db, "SELECT count(*) FROM video_purges", 0)
	count(t, db, "SELECT count(*) FROM video_purge_files", 0)
}

func TestDeletionRollbackIncludesManifestAndFTS(t *testing.T) {
	ctx, db, _, repo := fixture(t)
	if _, err := db.Exec("CREATE TRIGGER fail_delete BEFORE DELETE ON videos BEGIN SELECT RAISE(ABORT,'injected'); END"); err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, 1); err == nil {
		t.Fatal("expected rollback")
	}
	count(t, db, "SELECT count(*) FROM video_purges", 0)
	count(t, db, "SELECT count(*) FROM video_purge_files", 0)
	count(t, db, "SELECT count(*) FROM video_search", 2)
	count(t, db, "SELECT count(*) FROM transcripts", 2)
	count(t, db, "SELECT count(*) FROM assets", 3)
	count(t, db, "SELECT count(*) FROM videos", 2)
}

type uncertainRepository struct {
	deletion.Repository
	commit     bool
	unreadable bool
}

func (r uncertainRepository) Delete(ctx context.Context, id video.VideoID) error {
	if r.commit {
		if err := r.Repository.Delete(ctx, id); err != nil {
			return err
		}
	}
	return errors.New("uncertain")
}
func (r uncertainRepository) Pending(ctx context.Context, id video.VideoID) ([]deletion.File, bool, error) {
	if r.unreadable {
		return nil, false, errors.New("unreadable")
	}
	return r.Repository.Pending(ctx, id)
}

type recordingStorage struct {
	calls  int
	failAt int
}

func (s *recordingStorage) Remove(context.Context, deletion.File) error {
	s.calls++
	if s.calls == s.failAt {
		return errors.New("injected filesystem failure")
	}
	return nil
}

func TestUncertainCommitRequiresDurableProof(t *testing.T) {
	for _, tc := range []struct{ commit, unreadable bool }{{false, false}, {true, false}, {true, true}} {
		t.Run(map[bool]string{true: "commit", false: "rollback"}[tc.commit]+map[bool]string{true: " unreadable", false: " readable"}[tc.unreadable], func(t *testing.T) {
			ctx, _, _, repo := fixture(t)
			storage := &recordingStorage{}
			service := deletion.NewService(uncertainRepository{repo, tc.commit, tc.unreadable}, storage, &video.Activity{})
			_, err := service.Delete(ctx, 1)
			proven := tc.commit && !tc.unreadable
			if (err == nil) != proven || (storage.calls > 0) != proven {
				t.Fatal(storage.calls, err)
			}
		})
	}
}

func TestPartialPurgeBusyAndRetry(t *testing.T) {
	ctx, db, _, repo := fixture(t)
	activity := &video.Activity{}
	storage := &recordingStorage{failAt: 2}
	service := deletion.NewService(repo, storage, activity)
	release, _ := activity.Use(1)
	if _, err := service.Delete(ctx, 1); !errors.Is(err, video.ErrBusy) {
		t.Fatal(err)
	}
	count(t, db, "SELECT count(*) FROM videos", 2)
	release()
	unrelated, _ := activity.Use(2)
	defer unrelated()
	pending, err := service.Delete(ctx, 1)
	if err != nil || !pending {
		t.Fatal(pending, err)
	}
	count(t, db, "SELECT count(*) FROM video_purges", 1)
	pending, err = service.Delete(ctx, 1)
	if err != nil || pending {
		t.Fatal(pending, err)
	}
	count(t, db, "SELECT count(*) FROM video_purges", 0)
	if _, err := service.Delete(ctx, 0); !errors.Is(err, video.ErrInvalidInput) {
		t.Fatal(err)
	}
}

func TestLateNoteAndPlaybackCannotRecreateDeletedParents(t *testing.T) {
	ctx, db, _, repo := fixture(t)
	if err := repo.Delete(ctx, 1); err != nil {
		t.Fatal(err)
	}
	_, err := sqlite.NewNoteRepository(db).Save(ctx, 1, "late", 0, time.Now())
	if !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	_, err = sqlite.NewNoteRepository(db).Save(ctx, 1, "late", 1, time.Now())
	if !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	position := int64(500)
	if err := sqlite.NewPlaybackRepository(db).Save(ctx, 1, 1, &position); !errors.Is(err, video.ErrVideoSourceNotFound) {
		t.Fatal(err)
	}
	if _, err := sqlite.NewNoteRepository(db).Get(ctx, 1); errors.Is(err, note.ErrNotFound) || !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	count(t, db, "SELECT count(*) FROM notes WHERE video_id=1", 0)
	count(t, db, "SELECT count(*) FROM video_search WHERE rowid=1", 0)
}

type completionFailure struct{ deletion.Repository }

func (r completionFailure) Complete(context.Context, video.VideoID) error {
	return errors.New("commit uncertain")
}
func TestCleanupConfirmationFailureRemainsRetryable(t *testing.T) {
	ctx, _, _, repo := fixture(t)
	storage := &recordingStorage{}
	service := deletion.NewService(completionFailure{repo}, storage, &video.Activity{})
	if pending, err := service.Delete(ctx, 1); err != nil || !pending {
		t.Fatal(pending, err)
	}
	if _, exists, err := repo.Pending(ctx, 1); err != nil || !exists {
		t.Fatal(exists, err)
	}
	service = deletion.NewService(repo, storage, &video.Activity{})
	if pending, err := service.Delete(ctx, 1); err != nil || pending {
		t.Fatal(pending, err)
	}
}

func TestCanceledRequestDoesNotAuthorizeDeletion(t *testing.T) {
	ctx, db, _, repo := fixture(t)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	storage := &recordingStorage{}
	service := deletion.NewService(repo, storage, &video.Activity{})
	if _, err := service.Delete(canceled, 1); err == nil {
		t.Fatal("cancellation ignored")
	}
	if storage.calls != 0 {
		t.Fatal("unproven deletion")
	}
	count(t, db, "SELECT count(*) FROM videos", 2)
	count(t, db, "SELECT count(*) FROM video_purges", 0)
}
