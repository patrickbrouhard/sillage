package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestMediaProvenanceUniquenessAndKnowledgeSurvivesDeletion(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "test.db"))
	ctx := context.Background()
	videos := NewVideoRepository(db)
	create := func(external string) video.Video {
		v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now().UTC(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: external, Title: external}}})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	v, other := create("first"), create("second")
	repo := NewMediaRepository(db)
	source := v.Sources[0].ID
	f := media.File{VideoID: v.ID, OriginSourceID: &source, Path: "file.mp4", Format: "mp4", Size: 100, DurationMS: 1000, AddedAt: time.Now().UTC().Truncate(time.Millisecond)}
	wrong := f
	wrong.VideoID = other.ID
	if _, err := repo.Save(ctx, wrong); err == nil {
		t.Fatal("accepted foreign source")
	}
	saved, err := repo.Save(ctx, f)
	if err != nil {
		t.Fatal(err)
	}
	duplicate := f
	duplicate.Path = "other.mp4"
	if _, err := repo.Save(ctx, duplicate); err == nil {
		t.Fatal("accepted duplicate source")
	}
	if _, err := db.Exec("INSERT INTO notes (video_id, content_md, created_at, updated_at, revision) VALUES (?, 'knowledge', ?, ?, 1)", v.ID, formatDate(f.AddedAt), formatDate(f.AddedAt)); err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, saved.ID); err != nil {
		t.Fatal(err)
	}
	var content string
	if err := db.QueryRow("SELECT content_md FROM notes WHERE video_id = ?", v.ID).Scan(&content); err != nil || content != "knowledge" {
		t.Fatalf("%q %v", content, err)
	}
	if _, err := videos.Get(ctx, v.ID); err != nil {
		t.Fatal(err)
	}
	// Le modèle général permet plusieurs médias sans provenance, mais jamais un doublon de chemin.
	f.OriginSourceID = nil
	if _, err := repo.Save(ctx, f); err != nil {
		t.Fatal(err)
	}
	f.Path = "another.webm"
	f.Format = "webm"
	if _, err := repo.Save(ctx, f); err != nil {
		t.Fatal(err)
	}
}
