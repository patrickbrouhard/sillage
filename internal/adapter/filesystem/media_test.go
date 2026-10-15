package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/media"
)

func published(t *testing.T, s *Media) media.File {
	t.Helper()
	stage, err := s.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Discard(stage)
	if err := os.WriteFile(filepath.Join(stage, "media.webm"), []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	name, err := s.Publish(context.Background(), stage, media.Acquired{Format: "webm", Size: 8, DurationMS: 1000})
	if err != nil {
		t.Fatal(err)
	}
	return media.File{Path: name, Format: "webm", Size: 8, DurationMS: 1000}
}

func TestMediaRecoveryAtPublicationAndDeletionBoundaries(t *testing.T) {
	ctx := context.Background()
	for _, boundary := range []string{"published_before_sql", "published_after_sql", "delete_before_sql", "delete_after_sql"} {
		t.Run(boundary, func(t *testing.T) {
			s := NewMedia(filepath.Join(t.TempDir(), "media"))
			if err := s.Recover(ctx, nil); err != nil {
				t.Fatal(err)
			}
			f := published(t, s)
			var files []media.File
			if boundary == "published_after_sql" || boundary == "delete_before_sql" {
				files = []media.File{f}
			}
			if boundary == "delete_before_sql" || boundary == "delete_after_sql" {
				if err := s.StageDelete(f); err != nil {
					t.Fatal(err)
				}
			}
			stage, err := s.Prepare()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(stage, "partial.part"), []byte("partial"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(s.root, "user-file.txt"), []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := s.Recover(ctx, files); err != nil {
				t.Fatal(err)
			}
			entries, err := os.ReadDir(s.root)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1+len(files) {
				t.Fatalf("entries: %v", entries)
			}
			if len(files) > 0 {
				if err := s.Check(f); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := os.Stat(filepath.Join(s.root, "user-file.txt")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMediaRecoveryPreservesUncertainPaths(t *testing.T) {
	s := NewMedia(t.TempDir())
	orphan := published(t, s)
	if err := s.Recover(context.Background(), []media.File{{Path: "../outside"}}); err == nil {
		t.Fatal("accepted unsafe reference")
	}
	if err := s.Check(orphan); err != nil {
		t.Fatal("deleted before validating references", err)
	}
	target := filepath.Join(t.TempDir(), "keep")
	if err := os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	name := "media-00000000000000000000000000000000.mp4"
	if err := os.Symlink(target, filepath.Join(s.root, name)); err != nil {
		t.Fatal(err)
	}
	if err := s.Recover(context.Background(), nil); err == nil {
		t.Fatal("accepted symlink")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal(err)
	}
}

func TestMediaPublicationRejectsPartialAndDeletionCanRestore(t *testing.T) {
	s := NewMedia(t.TempDir())
	stage, err := s.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Discard(stage)
	if err := os.WriteFile(filepath.Join(stage, "media.mp4"), []byte("bad"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Publish(context.Background(), stage, media.Acquired{Format: "mp4", Size: 8}); err == nil {
		t.Fatal("published incomplete")
	}
	f := published(t, s)
	if err := s.StageDelete(f); err != nil {
		t.Fatal(err)
	}
	if err := s.Restore(f); err != nil {
		t.Fatal(err)
	}
	if err := s.Check(f); err != nil {
		t.Fatal(err)
	}
}
