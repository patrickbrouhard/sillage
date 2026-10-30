package deletion_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/deletion"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type interruptedStorage struct{ deletion.Storage }

func (s interruptedStorage) Remove(ctx context.Context, file deletion.File) error {
	if err := s.Storage.Remove(ctx, file); err != nil {
		return err
	}
	// Simuler la perte du processus après un effacement durable, sans aucun defer.
	os.Exit(17)
	return nil
}

func TestDeletionCrashProcess(t *testing.T) {
	root := os.Getenv("SILLAGE_DELETE_CRASH_ROOT")
	if root == "" {
		t.Skip("subprocess only")
	}
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(root, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("SILLAGE_DELETE_CRASH_PHASE") == "before_commit" {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("INSERT INTO video_purges(video_id) VALUES (1); DELETE FROM notes WHERE video_id=1; DELETE FROM video_search WHERE rowid=1"); err != nil {
			t.Fatal(err)
		}
		os.Exit(17)
	}
	storage := filesystem.NewPurge(filepath.Join(root, "media"), filepath.Join(root, "assets"), filepath.Join(root, "transcripts"))
	service := deletion.NewService(sqlite.NewDeletionRepository(db), interruptedStorage{storage}, &video.Activity{})
	if _, err := service.Delete(ctx, 1); err != nil {
		t.Fatal(err)
	}
	t.Fatal("crash boundary not reached")
}

func TestProcessInterruptionPreservesAuthorizationAndRecovery(t *testing.T) {
	for _, phase := range []string{"before_commit", "during_purge"} {
		t.Run(phase, func(t *testing.T) {
			ctx, db, root, _ := fixture(t)
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			process := exec.Command(os.Args[0], "-test.run=^TestDeletionCrashProcess$")
			process.Env = append(os.Environ(), "SILLAGE_DELETE_CRASH_ROOT="+root, "SILLAGE_DELETE_CRASH_PHASE="+phase)
			output, err := process.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 17 {
				t.Fatalf("unexpected subprocess result: %v %s", err, output)
			}
			db, err = sqlite.Open(ctx, filepath.Join(root, "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			repo := sqlite.NewDeletionRepository(db)
			storage := filesystem.NewPurge(filepath.Join(root, "media"), filepath.Join(root, "assets"), filepath.Join(root, "transcripts"))
			if err := deletion.NewService(repo, storage, &video.Activity{}).Recover(ctx); err != nil {
				t.Fatal(err)
			}
			want := 0
			if phase == "before_commit" {
				want = 1
			}
			count(t, db, "SELECT count(*) FROM videos WHERE id=1", want)
			count(t, db, "SELECT count(*) FROM notes WHERE video_id=1", want)
			count(t, db, "SELECT count(*) FROM video_search WHERE rowid=1", want)
			count(t, db, "SELECT count(*) FROM video_purges", 0)
			_, err = os.Stat(filepath.Join(root, "media", mediaPath))
			if (err == nil) != (phase == "before_commit") {
				t.Fatal("unexpected physical state", err)
			}
			if _, err := os.Stat(filepath.Join(root, "transcripts/snapshot-999.json3")); err != nil {
				t.Fatal("orphan lost", err)
			}
		})
	}
}
