package filesystem

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/logging"
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
			if len(entries) != 3 {
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
	if err := s.Recover(context.Background(), []media.File{{Path: "../outside"}}); err != nil {
		t.Fatal(err)
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
	if err := s.Recover(context.Background(), nil); err != nil {
		t.Fatal(err)
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

func TestRecoveryAfterOldDatabaseRestorePreservesRecentMedia(t *testing.T) {
	storage := NewMedia(t.TempDir())
	old := published(t, storage)
	recent := published(t, storage)
	if err := storage.Recover(context.Background(), []media.File{old}); err != nil {
		t.Fatal(err)
	}
	if err := storage.Check(recent); err != nil {
		t.Fatal("recent media lost after older database restore", err)
	}
}

func TestRecoveryPreservesConflictingDeletion(t *testing.T) {
	storage := NewMedia(t.TempDir())
	f := published(t, storage)
	path := filepath.Join(storage.root, f.Path)
	if err := os.WriteFile(path+".deleting", []byte("different"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := storage.Recover(context.Background(), []media.File{f}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path, path + ".deleting"} {
		if _, err := os.Stat(name); err != nil {
			t.Fatal(err)
		}
	}
	if err := storage.Check(f); err == nil {
		t.Fatal("ambiguous file available")
	}
	if err := storage.StageDelete(f); err == nil {
		t.Fatal("ambiguous deletion allowed")
	}
}

func TestAdditionalContainerAndUnsafeNames(t *testing.T) {
	storage := NewMedia(t.TempDir())
	for _, format := range []string{"mkv", "mov", "../../outside"} {
		stage, err := storage.Prepare()
		if err != nil {
			t.Fatal(err)
		}
		defer storage.Discard(stage)
		if format == "../../outside" {
			if _, err := storage.Publish(context.Background(), stage, media.Acquired{Format: format, Size: 8, DurationMS: 1000}); err == nil {
				t.Fatal("unsafe extension accepted")
			}
			continue
		}
		if err := os.WriteFile(filepath.Join(stage, "media."+format), []byte("complete"), 0600); err != nil {
			t.Fatal(err)
		}
		name, err := storage.Publish(context.Background(), stage, media.Acquired{Format: format, Size: 8, DurationMS: 1000})
		if err != nil {
			t.Fatal(err)
		}
		if err := storage.Check(media.File{Path: name, Size: 8}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRecoveryLoggingOmitsHostPaths(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "DEBUG", "json")
	ctx := logging.WithLogger(context.Background(), logger)
	root := filepath.Join(t.TempDir(), "PRIVATE")
	s := NewMedia(root)
	if err := s.Recover(ctx, nil); err != nil {
		t.Fatal(err)
	}
	f := published(t, s)
	f.ID = 12
	if err := s.StageDelete(f); err != nil {
		t.Fatal(err)
	}
	if err := s.Recover(ctx, []media.File{f}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "media.restored") {
		t.Fatal(output.String())
	}
	if err := os.Remove(filepath.Join(root, f.Path)); err != nil {
		t.Fatal(err)
	}
	if err := s.Recover(ctx, []media.File{f}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "media.unavailable") || strings.Contains(output.String(), "PRIVATE") {
		t.Fatal(output.String())
	}
}

func TestOpenRejectsUnsafeOrChangedMedia(t *testing.T) {
	for _, kind := range []string{"valid", "symlink", "directory", "size", "missing", "deleting", "traversal", "root-symlink"} {
		t.Run(kind, func(t *testing.T) {
			s := NewMedia(filepath.Join(t.TempDir(), "media"))
			if err := s.Recover(context.Background(), nil); err != nil {
				t.Fatal(err)
			}
			f := published(t, s)
			path := filepath.Join(s.root, f.Path)
			switch kind {
			case "symlink":
				os.Rename(path, path+".saved")
				os.Symlink(path+".saved", path)
			case "directory":
				os.Remove(path)
				os.Mkdir(path, 0700)
			case "size":
				f.Size++
			case "missing":
				os.Remove(path)
			case "deleting":
				os.WriteFile(path+".deleting", []byte("complete"), 0600)
			case "traversal":
				f.Path = "../" + f.Path
			case "root-symlink":
				os.Rename(s.root, s.root+".saved")
				os.Symlink(s.root+".saved", s.root)
			}
			content, err := s.Open(f)
			if kind == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				content.Close()
			} else if err == nil {
				content.Close()
				t.Fatal("unsafe media opened")
			}
		})
	}
}
