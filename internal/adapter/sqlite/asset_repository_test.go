package sqlite

import (
	"context"
	"fmt"
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

func TestAssetCatalogueOrderScopeAndStates(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{
		{Provider: "youtube", ExternalID: "one", Title: "one"},
		{Provider: "youtube", ExternalID: "two", Title: "two"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	other, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "other", Title: "other"}}})
	if err != nil {
		t.Fatal(err)
	}
	repo := NewAssetRepository(db)
	var ids []int64
	for i, timestamp := range []int64{900, 100, 100, 500} {
		source := v.Sources[i%2].ID
		a, err := repo.Create(ctx, asset.Asset{VideoID: v.ID, SourceID: &source, TimestampMS: &timestamp, Type: "screenshot", RequestID: fmt.Sprint("request", i), CreatedAt: time.Now().Add(-time.Duration(i) * time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, a.ID)
	}
	path := "retained.png"
	if err := repo.Finish(ctx, ids[1], "available", &path, 12, ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.Finish(ctx, ids[2], "failed", nil, 0, "capture_failed"); err != nil {
		t.Fatal(err)
	}
	source, timestamp := other.Sources[0].ID, int64(0)
	if _, err := repo.Create(ctx, asset.Asset{VideoID: other.ID, SourceID: &source, TimestampMS: &timestamp, Type: "screenshot", RequestID: "outside", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	first, err := repo.List(ctx, v.ID, 0, 2)
	if err != nil || len(first) != 2 {
		t.Fatalf("%+v %v", first, err)
	}
	if first[0].ID != ids[1] || first[1].ID != ids[2] || first[0].Status != "available" || first[1].Status != "failed" || *first[0].SourceID == *first[1].SourceID {
		t.Fatalf("%+v", first)
	}
	next, err := repo.List(ctx, v.ID, 2, 2)
	if err != nil || len(next) != 2 || next[0].ID != ids[3] || next[1].ID != ids[0] || next[0].Status != "pending" {
		t.Fatalf("%+v %v", next, err)
	}
	empty, err := repo.List(ctx, v.ID, 4, 2)
	if err != nil || len(empty) != 0 {
		t.Fatalf("%+v %v", empty, err)
	}
	// La consultation n'altère ni l'état terminal ni le fichier conservé.
	a, err := repo.Get(ctx, ids[1])
	if err != nil || a.Path == nil || *a.Path != path || a.Status != "available" {
		t.Fatalf("%+v %v", a, err)
	}
}
