package filesystem

import (
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/asset"
)

func TestAssetPublicationAndConservation(t *testing.T) {
	root := filepath.Join(t.TempDir(), "assets")
	storage := NewAssets(root)
	stage, err := storage.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(stage, "frame.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	f.Close()
	timestamp := int64(762345)
	a := asset.Asset{ID: 12, TimestampMS: &timestamp}
	name, size, err := storage.Publish(context.Background(), stage, a)
	if err != nil || !strings.Contains(name, "762345ms") {
		t.Fatalf("%s %d %v", name, size, err)
	}
	a.Path = &name
	a.Size = size
	if err := storage.Discard(stage); err != nil {
		t.Fatal(err)
	}
	file, err := storage.Open(a)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	// Un nouvel adapter ne nettoie pas un fichier publié sans référence SQL.
	next := NewAssets(root)
	stage, err = next.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	next.Discard(stage)
	if _, err := os.Stat(filepath.Join(root, name)); err != nil {
		t.Fatal(err)
	}
	unsafe := "../outside.png"
	a.Path = &unsafe
	if _, err := next.Open(a); err == nil {
		t.Fatal("unsafe path accepted")
	}
	a.Path = &name
	os.Remove(filepath.Join(root, name))
	if err := os.Symlink("/etc/passwd", filepath.Join(root, name)); err != nil {
		t.Fatal(err)
	}
	if _, err := next.Open(a); err == nil {
		t.Fatal("symlink accepted")
	}
}

func TestAssetRejectsIncompletePNG(t *testing.T) {
	storage := NewAssets(filepath.Join(t.TempDir(), "assets"))
	stage, err := storage.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Discard(stage)
	os.WriteFile(filepath.Join(stage, "frame.png"), []byte("\x89PNG\r\n\x1a\n"), 0600)
	ts := int64(0)
	if _, _, err := storage.Publish(context.Background(), stage, asset.Asset{ID: 1, TimestampMS: &ts}); err == nil {
		t.Fatal("truncated PNG accepted")
	}
	entries, err := os.ReadDir(storage.root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("unexpected publication %v %v", entries, err)
	}
}
