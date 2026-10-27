package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestTagCatalogLifecycleAndProjection(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "catalog.db")
	db := openTestDB(t, path)
	tags := video.NewTagService(NewTagRepository(db))
	first := searchFixture(t, db, "first")
	second := searchFixture(t, db, "second")
	indirect := searchFixture(t, db, "indirect")
	linked, err := tags.Add(ctx, first.ID, []string{"originaltag", "unused"})
	if err != nil {
		t.Fatal(err)
	}
	id := linked[0].ID
	if err := tags.Remove(ctx, first.ID, linked[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tags.Add(ctx, second.ID, []string{"originaltag"}); err != nil {
		t.Fatal(err)
	}
	persons := video.NewPersonService(NewPersonRepository(db))
	person, err := persons.Create(ctx, "Person")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := persons.AddTags(ctx, person.ID, []string{"originaltag"}); err != nil {
		t.Fatal(err)
	}
	if err := persons.SetVideo(ctx, indirect.ID, person.ID, true); err != nil {
		t.Fatal(err)
	}
	publishers := NewPublisherRepository(db)
	for _, externalID := range []string{"one", "two"} {
		p, err := publishers.CreateOrFind(ctx, video.Publisher{Provider: "local", ExternalID: externalID})
		if err != nil {
			t.Fatal(err)
		}
		name, _ := video.NormalizeTagName("originaltag")
		if _, err := publishers.AddTags(ctx, p.Publisher.ID, []video.TagName{name}); err != nil {
			t.Fatal(err)
		}
		if err := publishers.SetSource(ctx, indirect.ID, indirect.Sources[0].ID, &p.Publisher.ID); err != nil {
			t.Fatal(err)
		}
	}
	want := []video.TagCatalogEntry{
		{Tag: linked[0], VideoCount: 2, PublisherCount: 2, PersonCount: 1},
		{Tag: linked[1]},
	}
	if got, err := tags.Catalog(ctx); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatal(got, err)
	}
	renamed, err := tags.Rename(ctx, id, " renamedtag ")
	if err != nil || renamed != (video.Tag{ID: id, Name: "renamedtag"}) {
		t.Fatal(renamed, err)
	}
	if got := searchIDs(t, db, "originaltag"); len(got) != 0 {
		t.Fatal(got)
	}
	if got := searchIDs(t, db, "renamedtag"); len(got) != 2 {
		t.Fatal(got)
	}
	// La nouvelle identité réutilise les liens ; l'ancien nom peut créer un autre tag.
	if got, err := tags.Add(ctx, second.ID, []string{"RENAMEDTAG"}); err != nil || len(got) != 1 || got[0] != renamed {
		t.Fatal(got, err)
	}
	old, err := tags.Add(ctx, first.ID, []string{"originaltag"})
	if err != nil || len(old) != 2 || old[1].ID == id {
		t.Fatal(old, err)
	}
	// Une association ajoutée après lecture des compteurs doit également disparaître.
	if _, err := tags.Add(ctx, indirect.ID, []string{"renamedtag"}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := tags.Delete(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if got := searchIDs(t, db, "renamedtag"); len(got) != 0 {
		t.Fatal(got)
	}
	for _, table := range []string{"video_tags", "publisher_tags", "person_tags"} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE tag_id = ?", id).Scan(&count); err != nil || count != 0 {
			t.Fatal(table, count, err)
		}
	}
	for table, wantCount := range map[string]int{"videos": 3, "publishers": 2, "persons": 1, "video_persons": 1} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != wantCount {
			t.Fatal(table, count, err)
		}
	}
	if _, err := tags.Rename(ctx, id, "missing"); !errors.Is(err, video.ErrTagNotFound) {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	got, err := NewTagRepository(db).Catalog(ctx)
	if err != nil || len(got) != 2 || got[0].Tag != linked[1] || got[0].VideoCount != 0 || got[1].Name != "originaltag" {
		t.Fatal(got, err)
	}
}

func TestTagRenameUnicodeIdentity(t *testing.T) {
	ctx := context.Background()
	for _, pair := range [][2]string{
		{"Café", "CAFE\u0301"}, {"Straße", "STRASSE"}, {"Σ", "ς"},
	} {
		t.Run(pair[0], func(t *testing.T) {
			db := openTestDB(t, filepath.Join(t.TempDir(), "unicode.db"))
			v := searchFixture(t, db, "video")
			s := video.NewTagService(NewTagRepository(db))
			tags, err := s.Add(ctx, v.ID, []string{pair[0], "other"})
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.Rename(ctx, tags[0].ID, pair[1])
			if err != nil || got.ID != tags[0].ID || got.Name != pair[1] {
				t.Fatal(got, err)
			}
			if _, err := s.Rename(ctx, tags[1].ID, pair[0]); !errors.Is(err, video.ErrTagConflict) {
				t.Fatal(err)
			}
			if got, err := s.List(ctx); err != nil || len(got) != 2 || got[0].Name != pair[1] || got[1] != tags[1] {
				t.Fatal(got, err)
			}
		})
	}
	db := openTestDB(t, filepath.Join(t.TempDir(), "distinct.db"))
	v := searchFixture(t, db, "video")
	s := video.NewTagService(NewTagRepository(db))
	tags, err := s.Add(ctx, v.ID, []string{"Café", "Go"})
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"Cafe", "Ｇｏ"} {
		if _, err := s.Rename(ctx, tags[i].ID, name); err != nil {
			t.Fatal(err)
		}
		if got, err := s.Add(ctx, v.ID, []string{tags[i].Name}); err != nil || len(got) != i+3 {
			t.Fatal(got, err)
		}
	}
}

func TestTagCatalogRollback(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "rollback.db"))
	v := searchFixture(t, db, "video")
	s := video.NewTagService(NewTagRepository(db))
	tags, err := s.Add(ctx, v.ID, []string{"retainedtag"})
	if err != nil {
		t.Fatal(err)
	}
	person, err := NewPersonRepository(db).Create(ctx, "Person")
	if err != nil {
		t.Fatal(err)
	}
	name, _ := video.NormalizeTagName("retainedtag")
	if _, err := NewPersonRepository(db).AddTags(ctx, person.ID, []video.TagName{name}); err != nil {
		t.Fatal(err)
	}
	before, _ := s.Catalog(ctx)
	// L'échec tardif de projection doit restaurer le nom, la clé et tous les liens.
	if _, err := db.Exec("ALTER TABLE video_search RENAME TO broken_search"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Rename(ctx, tags[0].ID, "losttag"); err == nil {
		t.Fatal("rename committed without projection")
	}
	if err := s.Delete(ctx, tags[0].ID); err == nil {
		t.Fatal("delete committed without projection")
	}
	if got, err := s.Catalog(ctx); err != nil || !reflect.DeepEqual(got, before) {
		t.Fatal(got, err)
	}
	if _, err := db.Exec("ALTER TABLE broken_search RENAME TO video_search"); err != nil {
		t.Fatal(err)
	}
	if got := searchIDs(t, db, "retainedtag"); len(got) != 1 {
		t.Fatal(got)
	}
	if got := searchIDs(t, db, "losttag"); len(got) != 0 {
		t.Fatal(got)
	}
	// Un échec au milieu des suppressions de liens doit également tout annuler.
	if _, err := db.Exec(`
		CREATE TRIGGER fail_person_tag_delete BEFORE DELETE ON person_tags
		BEGIN SELECT RAISE(ABORT, 'injected failure'); END
	`); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, tags[0].ID); err == nil {
		t.Fatal("partial deletion committed")
	}
	if got, err := s.Catalog(ctx); err != nil || !reflect.DeepEqual(got, before) {
		t.Fatal(got, err)
	}
}

func TestTagConcurrentRenames(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "concurrent.db"))
	v := searchFixture(t, db, "video")
	s := video.NewTagService(NewTagRepository(db))
	tags, err := s.Add(ctx, v.ID, []string{"firsttag", "secondtag"})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, tag := range tags {
		wg.Go(func() { _, err := s.Rename(ctx, tag.ID, "sharedtag"); errs <- err })
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			success++
		case errors.Is(err, video.ErrTagConflict):
			conflict++
		default:
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	// Deux corrections du même ID réussissent sans précondition de révision.
	for _, name := range []string{"correctionone", "correctiontwo"} {
		wg.Go(func() {
			_, err := s.Rename(ctx, tags[0].ID, name)
			if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if _, err := s.Rename(ctx, tags[0].ID, "finaltag"); err != nil {
		t.Fatal(err)
	}
	got, err := s.List(ctx)
	if err != nil || got[0].Name != "finaltag" || len(searchIDs(t, db, "finaltag")) != 1 {
		t.Fatal(got, err)
	}
	for _, q := range []string{"firsttag", "correctionone", "correctiontwo"} {
		if got := searchIDs(t, db, q); len(got) != 0 {
			t.Fatal(q, got)
		}
	}
}
