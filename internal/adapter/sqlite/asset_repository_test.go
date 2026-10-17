package sqlite

import (
	"context"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/video"
	"path/filepath"
	"testing"
	"time"
)

func TestAssetProvenanceRequestUniquenessAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := NewVideoRepository(db)
	create := func(key string) video.Video {
		v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: key, Title: key}}})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	v, other := create("first"), create("second")
	source := v.Sources[0].ID
	timestamp := int64(42)
	a := asset.Asset{VideoID: v.ID, SourceID: &source, TimestampMS: &timestamp, Type: "screenshot", RequestID: "request1234567890", CreatedAt: time.Now()}
	repo := NewAssetRepository(db)
	bad := a
	bad.VideoID = other.ID
	if _, err := repo.Create(ctx, bad); err == nil {
		t.Fatal("foreign source accepted")
	}
	saved, err := repo.Create(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Create(ctx, a); err == nil {
		t.Fatal("duplicate request")
	}
	a.RequestID = "request1234567891"
	second, err := repo.Create(ctx, a)
	if err != nil || second.ID == saved.ID {
		t.Fatal("timestamp deduplicated")
	}
	name := "complete.png"
	if err := repo.Finish(ctx, saved.ID, "available", &name, 8, ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.Finish(ctx, saved.ID, "failed", nil, 0, "oops"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo = NewAssetRepository(db)
	if err := repo.Interrupt(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := repo.ByRequest(ctx, saved.RequestID)
	if err != nil || first.Status != "available" || first.Path == nil {
		t.Fatalf("%+v %v", first, err)
	}
	pending, err := repo.Get(ctx, second.ID)
	if err != nil || pending.Status != "failed" || pending.ErrorCode != "capture_interrupted" {
		t.Fatalf("%+v %v", pending, err)
	}
}
