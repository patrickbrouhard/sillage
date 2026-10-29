package sqlite

import (
	"context"
	"errors"
	"github.com/patrickbrouhard/sillage/internal/playback"
	"github.com/patrickbrouhard/sillage/internal/video"
	"path/filepath"
	"testing"
)

func TestPlaybackLifecycle(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "playback.db")
	db := openTestDB(t, path)
	v, err := NewVideoRepository(db).Create(ctx, sampleVideo("playback"))
	if err != nil {
		t.Fatal(err)
	}
	source := v.Sources[0].ID
	service := playback.NewService(NewPlaybackRepository(db))
	if got, err := service.Get(ctx, v.ID, source); err != nil || got != nil {
		t.Fatalf("%v %v", got, err)
	}
	for _, value := range []int64{5000, 12000, 0, 8000} {
		if err := service.Save(ctx, v.ID, source, &value); err != nil {
			t.Fatal(err)
		}
		got, err := service.Get(ctx, v.ID, source)
		if err != nil || got == nil || *got != value {
			t.Fatalf("%v %v", got, err)
		}
	}
	bad := int64(-1)
	if err := service.Save(ctx, v.ID, source, &bad); !errors.Is(err, video.ErrInvalidInput) {
		t.Fatal(err)
	}
	if err := service.Save(ctx, v.ID+1, source, nil); !errors.Is(err, video.ErrVideoSourceNotFound) {
		t.Fatal(err)
	}
	reopened := openTestDB(t, path)
	persisted, err := NewPlaybackRepository(reopened).Get(ctx, v.ID, source)
	if err != nil || persisted == nil || *persisted != 8000 {
		t.Fatalf("%v %v", persisted, err)
	}
	for range 2 {
		if err := service.Save(ctx, v.ID, source, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := service.Get(ctx, v.ID, source); err != nil || got != nil {
		t.Fatalf("%v %v", got, err)
	}
}
