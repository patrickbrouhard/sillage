package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestRepositoryPersistence(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "videos.db")
	db := openTestDB(t, path)
	repo := NewVideoRepository(db)
	input := sampleVideo("one")
	input.Sources = append(input.Sources, video.VideoSource{Provider: "test", ExternalID: "two", Title: "Seconde source"})
	created, err := repo.Create(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID <= 0 || created.Sources[0].ID <= 0 || created.Sources[1].ID <= created.Sources[0].ID {
		t.Fatalf("invalid IDs: %#v", created)
	}
	for _, source := range created.Sources {
		if source.VideoID != created.ID {
			t.Fatal("incorrect video/source relationship")
		}
	}
	if input.ID != 0 || input.Sources[0].ID != 0 || input.Sources[0].VideoID != 0 {
		t.Fatal("Create mutated its argument")
	}
	var storedMS int64
	if err := db.QueryRow("SELECT created_at_ms FROM videos WHERE id = ?", created.ID).Scan(&storedMS); err != nil || storedMS != input.CreatedAt.UnixMilli() {
		t.Fatalf("stored timestamp = %d, error = %v", storedMS, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	repo = NewVideoRepository(db)
	got, err := repo.Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, created) {
		t.Fatalf("reopened result = %#v, want %#v", got, created)
	}
	for _, source := range created.Sources {
		got, err = repo.FindBySource(ctx, source.Provider, source.ExternalID)
		if err != nil || !reflect.DeepEqual(got, created) {
			t.Fatalf("FindBySource = %#v, error = %v", got, err)
		}
	}
	for _, lookup := range []func() (video.Video, error){
		func() (video.Video, error) { return repo.Get(ctx, created.ID+1) },
		func() (video.Video, error) { return repo.FindBySource(ctx, "other", "one") },
		func() (video.Video, error) { return repo.FindBySource(ctx, "youtube", "unknown") },
		func() (video.Video, error) { return repo.FindBySource(ctx, "youtube", "") },
	} {
		if _, err := lookup(); !errors.Is(err, video.ErrVideoNotFound) {
			t.Fatalf("unexpected error: %v", err)
		}
	}
}

func TestRepositoryOptionalFields(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "optional.db"))
	repo := NewVideoRepository(db)
	for _, duration := range []*int64{nil, new(int64)} {
		v := video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "test", Title: "Titre", DurationMS: duration}}}
		created, err := repo.Create(ctx, v)
		if err != nil {
			t.Fatal(err)
		}
		got, err := repo.Get(ctx, created.ID)
		if err != nil || !reflect.DeepEqual(got, created) {
			t.Fatalf("got %#v, error=%v", got, err)
		}
		var external, canonical, description, creator, thumbnail sql.NullString
		var storedDuration sql.NullInt64
		err = db.QueryRow(`SELECT external_id, canonical_url, description, creator, thumbnail_url, duration_ms
			FROM video_sources WHERE video_id = ?`, created.ID).Scan(&external, &canonical, &description, &creator, &thumbnail, &storedDuration)
		if err != nil {
			t.Fatal(err)
		}
		if external.Valid || canonical.Valid || description.Valid || creator.Valid || thumbnail.Valid {
			t.Fatal("absent strings must be SQL NULL")
		}
		if storedDuration.Valid != (duration != nil) || storedDuration.Int64 != 0 {
			t.Fatalf("unexpected duration: %#v", storedDuration)
		}
	}
	// Deux sources sans identité externe du même provider doivent coexister.
	assertCounts(t, db, 2, 2)
}

func TestRepositoryConstraintsAndRollback(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "rollback.db"))
	repo := NewVideoRepository(db)
	if _, err := repo.Create(ctx, sampleVideo("same")); err != nil {
		t.Fatal(err)
	}
	v := sampleVideo("fresh")
	v.Sources = append(v.Sources, sampleVideo("same").Sources[0])
	if _, err := repo.Create(ctx, v); !errors.Is(err, video.ErrSourceAlreadyExists) {
		t.Fatalf("unexpected error: %v", err)
	}
	assertCounts(t, db, 1, 1)
	if _, err := repo.FindBySource(ctx, "youtube", "fresh"); !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal("partial source survived")
	}

	v = sampleVideo("negative")
	negative := int64(-1)
	v.Sources[0].DurationMS = &negative
	if _, err := repo.Create(ctx, v); err == nil || errors.Is(err, video.ErrSourceAlreadyExists) {
		t.Fatalf("duration constraint must fail without conflict mapping: %v", err)
	}
	assertCounts(t, db, 1, 1)

	// L'identité est composée : un autre provider peut utiliser le même ID.
	v = sampleVideo("same")
	v.Sources[0].Provider = "test"
	if _, err := repo.Create(ctx, v); err != nil {
		t.Fatal(err)
	}
	assertCounts(t, db, 2, 2)
}

func TestRepositoryRejectsInvalidCreation(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "invalid.db"))
	repo := NewVideoRepository(db)
	for _, v := range []video.Video{
		{}, {CreatedAt: time.Now()}, {Sources: sampleVideo("x").Sources},
		{ID: 1, CreatedAt: time.Now(), Sources: sampleVideo("x").Sources},
		{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "", Title: "Titre"}}},
	} {
		if _, err := repo.Create(context.Background(), v); err == nil {
			t.Fatal("invalid creation accepted")
		}
	}
	assertCounts(t, db, 0, 0)
}

func TestAddVideoConcurrentCreation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "concurrent.db")
	// Deux pools indépendants exercent la garantie SQLite, sans verrou applicatif.
	db1 := openTestDB(t, path)
	db2 := openTestDB(t, path)
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	results := make(chan video.AddVideoResult, 2)
	failures := make(chan error, 2)
	for _, db := range []*sql.DB{db1, db2} {
		repo := &racingRepository{VideoRepository: NewVideoRepository(db), arrived: arrived, release: release}
		service := video.NewService(repo, fixedProvider{source: sampleVideo("same").Sources[0]})
		go func() {
			got, err := service.AddVideo(ctx, "https://youtu.be/same")
			results <- got
			failures <- err
		}()
	}
	// Les deux recherches doivent avoir réellement constaté l'absence avant Create.
	for range 2 {
		select {
		case <-arrived:
		case <-ctx.Done():
			close(release)
			t.Fatal(ctx.Err())
		}
	}
	close(release)
	a, b := <-results, <-results
	for range 2 {
		if err := <-failures; err != nil {
			t.Fatal(err)
		}
	}
	if a.Video.ID == 0 || !reflect.DeepEqual(a.Video, b.Video) || a.Created == b.Created {
		t.Fatalf("different results: %#v / %#v", a, b)
	}
	assertCounts(t, db1, 1, 1)
}

// racingRepository retient uniquement la première recherche de chaque appel.
type racingRepository struct {
	video.VideoRepository
	once    sync.Once
	arrived chan<- struct{}
	release <-chan struct{}
}

func (r *racingRepository) FindBySource(ctx context.Context, provider, externalID string) (video.Video, error) {
	v, err := r.VideoRepository.FindBySource(ctx, provider, externalID)
	r.once.Do(func() {
		r.arrived <- struct{}{}
		select {
		case <-r.release:
		case <-ctx.Done():
		}
	})
	return v, err
}

type fixedProvider struct{ source video.VideoSource }

func (p fixedProvider) Extract(context.Context, string) (video.VideoSource, error) {
	return p.source, nil
}

func sampleVideo(externalID string) video.Video {
	duration := int64(1025000)
	return video.Video{
		CreatedAt: time.Date(2026, 9, 7, 12, 30, 0, 123456789, time.FixedZone("test", 3600)),
		Sources: []video.VideoSource{{
			Provider: "youtube", ExternalID: externalID, CanonicalURL: "https://www.youtube.com/watch?v=" + externalID,
			Title: "Titre été", Description: "Texte\nmultiligne", Creator: "Créateur",
			DurationMS: &duration, ThumbnailURL: "https://example.com/thumbnail.jpg",
		}},
	}
}

func assertCounts(t *testing.T, db *sql.DB, videos, sources int) {
	t.Helper()
	for table, want := range map[string]int{"videos": videos, "video_sources": sources} {
		var got int
		if err := db.QueryRow(fmt.Sprintf("SELECT count(*) FROM %s", table)).Scan(&got); err != nil || got != want {
			t.Fatalf("%s count = %d, want %d, error = %v", table, got, want, err)
		}
	}
}

func TestAddVideoAfterReopenDoesNotRefresh(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "add-video.db")
	db := openTestDB(t, path)
	original := sampleVideo("same").Sources[0]
	service := video.NewService(NewVideoRepository(db), fixedProvider{source: original})
	first, err := service.AddVideo(ctx, "https://youtu.be/same")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db = openTestDB(t, path)
	changed := original
	changed.Title = "Nouveau titre"
	changed.Description = "Nouvelle description"
	changed.Creator = "Autre créateur"
	changed.ThumbnailURL = "https://example.com/changed.jpg"
	changed.DurationMS = nil
	service = video.NewService(NewVideoRepository(db), fixedProvider{source: changed})
	second, err := service.AddVideo(ctx, "https://www.youtube.com/watch?v=same")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first.Video, second.Video) || !first.Created || second.Created {
		t.Fatalf("implicit refresh after reopen: %#v / %#v", first, second)
	}
	assertCounts(t, db, 1, 1)
}

func TestRepositoryListOrderingAndSources(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "list.db"))
	repo := NewVideoRepository(db)
	empty, err := repo.List(ctx)
	if err != nil || len(empty) != 0 {
		t.Fatalf("%v %v", empty, err)
	}
	var created []video.Video
	for i, ms := range []int64{2000, 1000, 2000} {
		v := sampleVideo(fmt.Sprint(i))
		v.CreatedAt = time.UnixMilli(ms)
		v.Sources = append(v.Sources, video.VideoSource{Provider: "test", ExternalID: fmt.Sprint(i), Title: "second source"})
		got, err := repo.Create(ctx, v)
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, got)
	}
	got, err := repo.List(ctx)
	want := []video.Video{created[2], created[0], created[1]}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v: %v", got, want, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := repo.List(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.List(ctx); err == nil {
		t.Fatal("closed database accepted")
	}
}
