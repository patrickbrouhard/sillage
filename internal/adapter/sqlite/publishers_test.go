package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestPublishersPersonsAndUniversalTags(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "knowledge.db")
	db := openTestDB(t, path)
	publishers := NewPublisherRepository(db)
	persons := NewPersonRepository(db)
	videos := NewVideoRepository(db)
	person, err := persons.Create(ctx, "Lex")
	if err != nil {
		t.Fatal(err)
	}
	homonym, err := persons.Create(ctx, "Lex")
	if err != nil || homonym.ID == person.ID {
		t.Fatal(homonym, err)
	}
	account := video.Publisher{Provider: "youtube", ExternalID: "UC1234567890123456789012", Name: "Clips"}
	first, err := publishers.CreateOrFind(ctx, account)
	if err != nil || !first.Created {
		t.Fatal(first, err)
	}
	if err := publishers.SetPerson(ctx, first.Publisher.ID, &person.ID); err != nil {
		t.Fatal(err)
	}
	account.Name = "Changed"
	second, err := publishers.CreateOrFind(ctx, account)
	if err != nil || second.Created || second.Publisher.Name != "Clips" || *second.Publisher.PersonID != person.ID {
		t.Fatal(second, err)
	}
	input := sampleVideo("one")
	input.Sources[0].Publisher = &account
	v, err := videos.Create(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	got, err := videos.Get(ctx, v.ID)
	if err != nil || !reflect.DeepEqual(v, got) || len(got.PersonIDs) != 0 || got.Sources[0].Publisher.Name != "Clips" {
		t.Fatal(got, err)
	}
	other, err := videos.Create(ctx, sampleVideo("two"))
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := persons.SetVideo(ctx, other.ID, person.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	if err := persons.SetVideo(ctx, v.ID, person.ID, true); err != nil {
		t.Fatal(err)
	}
	for relation, want := range map[string]int{"direct": 2, "publisher": 1, "all": 2} {
		list, err := persons.Videos(ctx, person.ID, relation)
		if err != nil || len(list) != want {
			t.Fatal(relation, list, err)
		}
	}
	pt, err := video.NewPublisherService(publishers, nil).AddTags(ctx, first.Publisher.ID, []string{" Café "})
	if err != nil {
		t.Fatal(err)
	}
	nt, err := video.NewPersonService(persons).AddTags(ctx, person.ID, []string{"CAFE\u0301"})
	if err != nil || !reflect.DeepEqual(pt, nt) {
		t.Fatal(nt, err)
	}
	got, err = videos.Get(ctx, v.ID)
	if err != nil || len(got.Tags) != 0 {
		t.Fatal("tags propagated", got, err)
	}
	filtered, err := videos.ListByTag(ctx, pt[0].ID)
	if err != nil || len(filtered) != 0 {
		t.Fatal(filtered, err)
	}
	vt, err := video.NewTagService(NewTagRepository(db)).Add(ctx, v.ID, []string{"café"})
	if err != nil || !reflect.DeepEqual(vt, pt) {
		t.Fatal(vt, err)
	}
	if err := publishers.SetSource(ctx, other.ID, v.Sources[0].ID, &first.Publisher.ID); !errors.Is(err, video.ErrVideoSourceNotFound) {
		t.Fatal(err)
	}
	local := sampleVideo("local")
	local.Sources[0].Provider = "local"
	localVideo, err := videos.Create(ctx, local)
	if err != nil {
		t.Fatal(err)
	}
	if err := publishers.SetSource(ctx, localVideo.ID, localVideo.Sources[0].ID, &first.Publisher.ID); !errors.Is(err, video.ErrInvalidInput) {
		t.Fatal(err)
	}
	if err := publishers.SetSource(ctx, v.ID, v.Sources[0].ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := publishers.SetPerson(ctx, first.Publisher.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := persons.SetVideo(ctx, v.ID, person.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	got, err = NewVideoRepository(db).Get(ctx, v.ID)
	if err != nil || got.Sources[0].Publisher != nil || len(got.PersonIDs) != 0 || len(got.Tags) != 1 {
		t.Fatal(got, err)
	}
	stored, err := NewPublisherRepository(db).Get(ctx, first.Publisher.ID)
	if err != nil || stored.PersonID != nil || len(stored.Tags) != 1 {
		t.Fatal(stored, err)
	}
}

func TestPublisherConcurrentReuseAndAtomicRollback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db := openTestDB(t, filepath.Join(t.TempDir(), "concurrent.db"))
	r := NewVideoRepository(db)
	errs := make(chan error, 8)
	for i := range 8 {
		go func() {
			input := sampleVideo(fmt.Sprint(i))
			input.Sources[0].Publisher = &video.Publisher{Provider: "youtube", ExternalID: "shared"}
			_, err := r.Create(ctx, input)
			errs <- err
		}()
	}
	for range 8 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM publishers").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	input := sampleVideo("0")
	input.Sources[0].Publisher = &video.Publisher{Provider: "youtube", ExternalID: "rollback"}
	if _, err := r.Create(ctx, input); !errors.Is(err, video.ErrSourceAlreadyExists) {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT count(*) FROM publishers").Scan(&count); err != nil || count != 1 {
		t.Fatal("orphan publisher", count, err)
	}
}

func TestPublisherMigrationBacksUpAndPreservesKnowledge(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_transcripts.sql", "0003_notes_tags.sql"} {
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
		INSERT INTO video_sources (id, video_id, provider, external_id, title, creator)
		VALUES (7, 42, 'youtube', 'old', 'Title', 'Legacy name');
		INSERT INTO notes VALUES (42, '  Markdown\n', '2026-10-09T08:00:00.123Z', '2026-10-09T08:00:00.123Z');
		INSERT INTO tags VALUES (9, 'Go', 'go');
		INSERT INTO video_tags VALUES (42, 9);
		INSERT INTO transcripts VALUES (5, 7, 'en', 'youtube_auto', 'kept.json3', '2026-10-09T08:00:00.123Z');
		PRAGMA user_version = 3;
	`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db = openTestDB(t, path)
	backups, err := filepath.Glob(path + ".before-publishers-*.bak")
	if err != nil || len(backups) != 1 {
		t.Fatal(backups, err)
	}
	backup, err := sql.Open("sqlite", backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var creator string
	if err := backup.QueryRow("SELECT creator FROM video_sources WHERE id = 7").Scan(&creator); err != nil || creator != "Legacy name" {
		t.Fatal(creator, err)
	}
	got, err := NewVideoRepository(db).Get(ctx, 42)
	if err != nil || got.Sources[0].ID != 7 || got.Sources[0].Publisher != nil || got.Tags[0].ID != 9 {
		t.Fatal(got, err)
	}
	var snapshot string
	if err := db.QueryRow("SELECT local_path FROM transcripts WHERE id = 5").Scan(&snapshot); err != nil || snapshot != "kept.json3" {
		t.Fatal(snapshot, err)
	}
	var note string
	if err := db.QueryRow("SELECT content_md FROM notes WHERE video_id = 42").Scan(&note); err != nil || note != "  Markdown\\n" {
		t.Fatal(note, err)
	}
	if _, err := db.Exec("SELECT creator FROM video_sources"); err == nil {
		t.Fatal("creator still present")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, path)
	backups, _ = filepath.Glob(path + ".before-publishers-*.bak")
	if len(backups) != 1 {
		t.Fatal("unnecessary backup", backups)
	}
}

func TestUniversalTagsConcurrentAndRollback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db := openTestDB(t, filepath.Join(t.TempDir(), "tags.db"))
	publishers := NewPublisherRepository(db)
	persons := NewPersonRepository(db)
	p, err := publishers.CreateOrFind(ctx, video.Publisher{Provider: "youtube", ExternalID: "shared"})
	if err != nil {
		t.Fatal(err)
	}
	n, err := persons.Create(ctx, "Person")
	if err != nil {
		t.Fatal(err)
	}
	pubs := video.NewPublisherService(publishers, nil)
	people := video.NewPersonService(persons)
	errs := make(chan error, 12)
	for i := range 12 {
		go func() {
			var err error
			if i%2 == 0 {
				_, err = pubs.AddTags(ctx, p.Publisher.ID, []string{"Café"})
			} else {
				_, err = people.AddTags(ctx, n.ID, []string{"CAFE\u0301"})
			}
			errs <- err
		}()
	}
	for range 12 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"tags", "publisher_tags", "person_tags"} {
		var count int
		if err := db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 1 {
			t.Fatal(table, count, err)
		}
	}
	for _, table := range []string{"publisher_tags", "person_tags"} {
		_, err := db.Exec("CREATE TRIGGER fail_" + table + " BEFORE INSERT ON " + table + ` WHEN (SELECT name FROM tags WHERE id = NEW.tag_id) = 'Fail' BEGIN SELECT RAISE(ABORT, 'injected'); END`)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pubs.AddTags(ctx, p.Publisher.ID, []string{"Transient", "Fail"}); err == nil {
		t.Fatal("expected rollback")
	}
	if _, err := people.AddTags(ctx, n.ID, []string{"Transient", "Fail"}); err == nil {
		t.Fatal("expected rollback")
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM tags").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if _, err := pubs.AddTags(ctx, p.Publisher.ID, []string{"valid", " "}); !errors.Is(err, video.ErrInvalidInput) {
		t.Fatal(err)
	}
	for _, table := range []string{"publisher_tags", "person_tags", "publishers"} {
		if _, err := db.Exec("INSERT INTO " + table + " SELECT * FROM " + table); err == nil {
			t.Fatal("duplicate accepted", table)
		}
	}
}

func TestPublisherReaddPreservesExplicitSourceChoice(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "readd.db"))
	r := NewVideoRepository(db)
	publishers := NewPublisherRepository(db)
	source := sampleVideo("same").Sources[0]
	source.Publisher = &video.Publisher{Provider: "youtube", ExternalID: "original", Name: "Original"}
	service := video.NewService(r, fixedProvider{source: source})
	first, err := service.AddVideo(ctx, "url")
	if err != nil {
		t.Fatal(err)
	}
	other, err := publishers.CreateOrFind(ctx, video.Publisher{Provider: "youtube", ExternalID: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	if err := publishers.SetSource(ctx, first.Video.ID, first.Video.Sources[0].ID, &other.Publisher.ID); err != nil {
		t.Fatal(err)
	}
	second, err := service.AddVideo(ctx, "url")
	if err != nil || second.Created || second.Video.Sources[0].Publisher.ID != other.Publisher.ID {
		t.Fatal(second, err)
	}
	if err := publishers.SetSource(ctx, first.Video.ID, first.Video.Sources[0].ID, nil); err != nil {
		t.Fatal(err)
	}
	third, err := service.AddVideo(ctx, "url")
	if err != nil || third.Video.Sources[0].Publisher != nil {
		t.Fatal(third, err)
	}
}

func TestBackupFailurePreventsDestructiveMigration(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root contourne les permissions de répertoire nécessaires à cette injection d'échec")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_transcripts.sql", "0003_notes_tags.sql"} {
		script, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(script)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("PRAGMA user_version = 3"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0700)
	opened, err := Open(context.Background(), path)
	if opened != nil {
		opened.Close()
		t.Fatal("opened without backup")
	}
	if err == nil {
		t.Fatal("expected backup failure")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 3 {
		t.Fatal(version, err)
	}
	if _, err := db.Exec("SELECT creator FROM video_sources"); err != nil {
		t.Fatal("creator lost", err)
	}
}

func TestPublisherProviderConstraints(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "constraints.db"))
	ctx := context.Background()
	p, err := NewPublisherRepository(db).CreateOrFind(ctx, video.Publisher{Provider: "youtube", ExternalID: "account"})
	if err != nil {
		t.Fatal(err)
	}
	v, err := NewVideoRepository(db).Create(ctx, sampleVideo("one"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE video_sources SET provider = 'local', publisher_id = ? WHERE id = ?", p.Publisher.ID, v.Sources[0].ID); err == nil {
		t.Fatal("provider mismatch accepted")
	}
	if _, err := db.Exec("UPDATE publishers SET provider = 'local' WHERE id = ?", p.Publisher.ID); err == nil {
		t.Fatal("identity changed")
	}
	if _, err := db.Exec("UPDATE publishers SET person_id = 999 WHERE id = ?", p.Publisher.ID); err == nil {
		t.Fatal("missing person accepted")
	}
	if _, err := db.Exec("INSERT INTO video_persons VALUES (?, 999)", v.ID); err == nil {
		t.Fatal("missing person accepted")
	}
}
