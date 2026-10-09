package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestNoteLifecycleAndPersistence(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "notes.db")
	db := openTestDB(t, path)
	v, err := NewVideoRepository(db).Create(ctx, sampleVideo("notes"))
	if err != nil {
		t.Fatal(err)
	}
	r := NewNoteRepository(db)
	if _, err := r.Get(ctx, v.ID); !errors.Is(err, note.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := r.Get(ctx, v.ID+1); !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 9, 8, 0, 0, 123000000, time.UTC)
	if _, err := r.Save(ctx, v.ID+1, "lost", at); !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	first, err := r.Save(ctx, v.ID, "", at)
	if err != nil || !first.Created || first.Note.ContentMD != "" || !first.Note.CreatedAt.Equal(at) || !first.Note.UpdatedAt.Equal(at) {
		t.Fatalf("%+v %v", first, err)
	}
	content := "\t# Café\r\n\n  [12:42] **texte**  \n\x00fin\n"
	updated, err := r.Save(ctx, v.ID, content, at.Add(time.Second))
	if err != nil || updated.Created || updated.Note.ContentMD != content || !updated.Note.CreatedAt.Equal(at) || !updated.Note.UpdatedAt.Equal(at.Add(time.Second)) {
		t.Fatalf("%+v %v", updated, err)
	}
	same, err := r.Save(ctx, v.ID, content, at.Add(time.Hour))
	if err != nil || !reflect.DeepEqual(updated, same) {
		t.Fatalf("%+v %v", same, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	r = NewNoteRepository(db)
	got, err := r.Get(ctx, v.ID)
	if err != nil || !reflect.DeepEqual(got, updated.Note) {
		t.Fatalf("%+v %v", got, err)
	}
	empty, err := r.Save(ctx, v.ID, "", at.Add(2*time.Hour))
	if err != nil || empty.Created || empty.Note.ContentMD != "" || !empty.Note.CreatedAt.Equal(at) {
		t.Fatalf("%+v %v", empty, err)
	}
}

func TestTagsSharingFilteringRollbackAndPersistence(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "tags.db")
	db := openTestDB(t, path)
	r := NewVideoRepository(db)
	input := sampleVideo("one")
	input.Sources = append(input.Sources, video.VideoSource{Provider: "local", Title: "Other source"})
	v, err := r.Create(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	other, err := r.Create(ctx, sampleVideo("two"))
	if err != nil {
		t.Fatal(err)
	}
	tags := video.NewTagService(NewTagRepository(db))
	first, err := tags.Add(ctx, v.ID, []string{" Café ", "DevOps", "cafe\u0301", "devops", "Cafe"})
	if err != nil || len(first) != 3 || first[0].Name != "Café" {
		t.Fatalf("%+v %v", first, err)
	}
	second, err := tags.Add(ctx, other.ID, []string{"CAFÉ"})
	if err != nil || len(second) != 1 || second[0] != first[0] {
		t.Fatalf("%+v %v", second, err)
	}
	filtered, err := r.ListByTag(ctx, first[0].ID)
	if err != nil || len(filtered) != 2 || filtered[0].ID != other.ID || len(filtered[1].Sources) != 2 || !reflect.DeepEqual(filtered[1].Tags, first) {
		t.Fatalf("%+v %v", filtered, err)
	}
	found, err := r.FindBySource(ctx, "youtube", "one")
	if err != nil || !reflect.DeepEqual(found.Tags, first) {
		t.Fatalf("%+v %v", found, err)
	}
	// Faire échouer une association après la création de nouveaux tags prouve le rollback complet.
	_, err = db.Exec(`CREATE TRIGGER fail_tag BEFORE INSERT ON video_tags
		WHEN (SELECT name FROM tags WHERE id = NEW.tag_id) = 'Fail'
		BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tags.Add(ctx, v.ID, []string{"Transient", "Fail"}); err == nil {
		t.Fatal("expected failure")
	}
	all, err := tags.List(ctx)
	if err != nil || !reflect.DeepEqual(all, first) {
		t.Fatalf("partial tags: %+v %v", all, err)
	}
	found, err = r.Get(ctx, v.ID)
	if err != nil || !reflect.DeepEqual(found.Tags, first) {
		t.Fatalf("partial associations: %+v %v", found, err)
	}
	if _, err := tags.Add(ctx, 999, []string{"Absent"}); !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	if err := tags.Remove(ctx, 999, first[0].ID); !errors.Is(err, video.ErrVideoNotFound) {
		t.Fatal(err)
	}
	for range 2 {
		if err := tags.Remove(ctx, v.ID, first[1].ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tags.Remove(ctx, v.ID, 999); err != nil {
		t.Fatal(err)
	}
	for _, id := range []video.TagID{first[1].ID, 999} {
		got, err := r.ListByTag(ctx, id)
		if err != nil || len(got) != 0 {
			t.Fatalf("%+v %v", got, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	all, err = NewTagRepository(db).List(ctx)
	if err != nil || !reflect.DeepEqual(all, first) {
		t.Fatalf("%+v %v", all, err)
	}
	found, err = NewVideoRepository(db).Get(ctx, v.ID)
	if err != nil || !reflect.DeepEqual(found.Tags, []video.Tag{first[0], first[2]}) {
		t.Fatalf("%+v %v", found, err)
	}
}

func TestConcurrentNotesAndTags(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db := openTestDB(t, filepath.Join(t.TempDir(), "concurrent.db"))
	v, err := NewVideoRepository(db).Create(ctx, sampleVideo("concurrent"))
	if err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, 12)
	created := make(chan bool, 12)
	start := make(chan struct{})
	for i := range 12 {
		go func() {
			<-start
			name := []string{"Café", "CAFE\u0301"}[i%2]
			_, err := video.NewTagService(NewTagRepository(db)).Add(ctx, v.ID, []string{name})
			if err == nil {
				var result note.SaveResult
				result, err = NewNoteRepository(db).Save(ctx, v.ID, fmt.Sprint(i), time.Now())
				created <- result.Created
			} else {
				created <- false
			}
			errs <- err
		}()
	}
	close(start)
	creations := 0
	for range 12 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		if <-created {
			creations++
		}
	}
	if creations != 1 {
		t.Fatalf("note creations: %d", creations)
	}
	var count int
	for _, table := range []string{"tags", "video_tags", "notes"} {
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s: %d %v", table, count, err)
		}
	}
	// La base elle-même doit refuser les doublons, indépendamment des services.
	if _, err := db.Exec("INSERT INTO tags (name, identity_key) SELECT name, identity_key FROM tags"); err == nil {
		t.Fatal("duplicate identity accepted")
	}
	if _, err := db.Exec("INSERT INTO video_tags SELECT * FROM video_tags"); err == nil {
		t.Fatal("duplicate association accepted")
	}
}

func TestUpgradeFromTranscriptSchemaPreservesData(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_transcripts.sql"} {
		script, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(script)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.Exec(`
		INSERT INTO videos VALUES (42, '2026-10-09T08:00:00.123Z');
		INSERT INTO video_sources (id, video_id, provider, title) VALUES (7, 42, 'test', 'Preserved');
		INSERT INTO transcripts (video_source_id, language, provenance, local_path, last_fetched_at)
		VALUES (7, 'fr', 'youtube_auto', 'snapshot.json3', '2026-10-09T08:00:00.123Z');
		PRAGMA user_version = 2;
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	v, err := NewVideoRepository(db).Get(ctx, 42)
	if err != nil || len(v.Sources) != 1 || v.Sources[0].Title != "Preserved" || len(v.Tags) != 0 {
		t.Fatalf("%+v %v", v, err)
	}
	if _, err := NewNoteRepository(db).Save(ctx, 42, "kept", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := video.NewTagService(NewTagRepository(db)).Add(ctx, 42, []string{"Go"}); err != nil {
		t.Fatal(err)
	}
	var snapshot string
	if err := db.QueryRow("SELECT local_path FROM transcripts").Scan(&snapshot); err != nil || snapshot != "snapshot.json3" {
		t.Fatalf("%q %v", snapshot, err)
	}
}
