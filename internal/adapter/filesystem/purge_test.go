package filesystem

import (
	"context"
	"github.com/patrickbrouhard/sillage/internal/deletion"
	"os"
	"path/filepath"
	"testing"
)

func TestPurgeBoundsAndInterruptedMedia(t *testing.T) {
	root := t.TempDir()
	s := NewPurge(root, root, root)
	ctx := context.Background()
	name := "media-00000000000000000000000000000001.webm"
	for _, suffix := range []string{"", ".deleting"} {
		if err := os.WriteFile(filepath.Join(root, name+suffix), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := s.Remove(ctx, deletion.File{Kind: "media", Path: name}); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "keep")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, name)); err != nil {
		t.Fatal(err)
	}
	for _, file := range []deletion.File{
		{Kind: "media", Path: name}, {Kind: "media", Path: "../keep"}, {Kind: "transcript", Path: "user.json3"}, {Kind: "other", Path: name},
	} {
		if err := s.Remove(ctx, file); err == nil {
			t.Fatal(file)
		}
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "keep" {
		t.Fatal(string(data), err)
	}
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(root, linked); err != nil {
		t.Fatal(err)
	}
	if err := NewPurge(linked, linked, linked).Remove(ctx, deletion.File{Kind: "transcript", Path: "snapshot-1.json3"}); err == nil {
		t.Fatal("symlink root accepted")
	}
}
