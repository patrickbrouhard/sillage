package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// TestSearchRankingCorpus exprime des attentes ciblées sans figer les scores ni tout l'ordre.
func TestSearchRankingCorpus(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "corpus.db"))
	ctx := context.Background()
	makeVideo := func(title, description, publisher, note, tag string) video.Video {
		t.Helper()
		source := video.VideoSource{Provider: "local", Title: title, Description: description}
		if publisher != "" {
			source.Publisher = &video.Publisher{Provider: "local", ExternalID: publisher, Name: publisher}
		}
		v, err := NewVideoRepository(db).Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{source}})
		if err != nil {
			t.Fatal(err)
		}
		if note != "" {
			if _, err := NewNoteRepository(db).Save(ctx, v.ID, note, 0, time.Now()); err != nil {
				t.Fatal(err)
			}
		}
		if tag != "" {
			if _, err := video.NewTagService(NewTagRepository(db)).Add(ctx, v.ID, []string{tag}); err != nil {
				t.Fatal(err)
			}
		}
		return v
	}
	description := makeVideo("Présentation", "Kubernetes", "", "", "")
	publisher := makeVideo("Présentation", "", "Kubernetes", "", "")
	note := makeVideo("Présentation", "", "", "Kubernetes", "")
	title := makeVideo("Kubernetes", "", "", "", "")
	tag := makeVideo("Présentation", "", "", "", "Kubernetes")
	for i := range 12 {
		makeVideo(fmt.Sprintf("Fond %d", i), "autre contenu", "", "sans rapport", "")
	}
	page, err := search.NewService(NewSearchRepository(db)).Search(ctx, "kube", 1)
	if err != nil {
		t.Fatal(err)
	}
	positions := map[video.VideoID]int{}
	for i, r := range page.Results {
		positions[r.Video.ID] = i
	}
	if len(positions) != 5 {
		t.Fatalf("%v", positions)
	}
	for _, pair := range [][2]video.VideoID{{title.ID, description.ID}, {tag.ID, description.ID}, {note.ID, description.ID}, {publisher.ID, description.ID}} {
		if positions[pair[0]] >= positions[pair[1]] {
			t.Errorf("expected %d ahead of %d: %v", pair[0], pair[1], positions)
		}
	}
	// Les sources répétées strictement identiques ne gonflent pas le document classé.
	repeated := searchFixture(t, db, "Kubernetes", "Kubernetes", "Kubernetes")
	var projected string
	if err := db.QueryRow("SELECT titles FROM video_search WHERE rowid = ?", repeated.ID).Scan(&projected); err != nil || projected != "Kubernetes" {
		t.Fatalf("%q %v", projected, err)
	}
	long := makeVideo("Longue note", strings.Repeat("description ", 20000)+"finlointaine", "", "~~~bash\n"+strings.Repeat("commande /tmp/chemin\n", 10000)+"C++ C#\n~~~", "")
	ids := searchIDs(t, db, "finlointaine C++ C#")
	if len(ids) != 1 || ids[0] != long.ID {
		t.Fatal(ids)
	}
}

func TestSearchConcurrentSaveRebuildAndReaders(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db := openTestDB(t, filepath.Join(t.TempDir(), "concurrent.db"))
	v := searchFixture(t, db, "concurrence")
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	wg.Go(func() {
		for i := range 12 {
			if _, err := NewNoteRepository(db).Save(ctx, v.ID, fmt.Sprintf("version%d", i), int64(i), time.Now()); err != nil {
				errs <- err
				return
			}
		}
	})
	wg.Go(func() {
		for range 8 {
			if err := RebuildSearch(ctx, db); err != nil {
				errs <- err
				return
			}
		}
	})
	wg.Go(func() {
		for range 20 {
			page, err := search.NewService(NewSearchRepository(db)).Search(ctx, "concurrence", 1)
			if err != nil {
				errs <- err
				return
			}
			if len(page.Results) != 1 || page.Total != 1 {
				errs <- fmt.Errorf("missing video")
				return
			}
		}
	})
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if got := searchIDs(t, db, "version11"); len(got) != 1 || got[0] != v.ID {
		t.Fatal(got)
	}
	if got := searchIDs(t, db, "version0"); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestSearchFailedInitializationNeverPublishesReady(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "initialization.db")
	db := openTestDB(t, path)
	v := searchFixture(t, db, "recoverable")
	if _, err := db.Exec(`
  DELETE FROM video_search;
  DELETE FROM search_projection;
  CREATE TRIGGER reject_search_version BEFORE INSERT ON search_projection
  BEGIN SELECT RAISE(ABORT, 'controlled failure'); END;
 `); err != nil {
		t.Fatal(err)
	}
	db.Close()
	reopened, err := Open(ctx, path)
	if err == nil || reopened != nil {
		t.Fatal("incomplete index presented as ready")
	}
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := raw.QueryRow("SELECT count(*) FROM search_projection").Scan(&count); err != nil || count != 0 {
		t.Fatalf("%d %v", count, err)
	}
	if err := raw.QueryRow("SELECT count(*) FROM video_search").Scan(&count); err != nil || count != 0 {
		t.Fatalf("%d %v", count, err)
	}
	if _, err := raw.Exec("DROP TRIGGER reject_search_version"); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	reopened, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := searchIDs(t, reopened, "recoverable"); len(got) != 1 || got[0] != v.ID {
		t.Fatal(got)
	}
}

func TestSearchRebuildRollbackAfterProjectionAndVersionFailure(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "rollback.db"))
	v := searchFixture(t, db, "original")
	// La faute survient après extraction et INSERT de tous les documents.
	if _, err := db.Exec(`
  CREATE TRIGGER reject_search_version BEFORE INSERT ON search_projection
  BEGIN SELECT RAISE(ABORT, 'controlled failure'); END;
 `); err != nil {
		t.Fatal(err)
	}
	if err := RebuildSearch(ctx, db); err == nil {
		t.Fatal("rebuild unexpectedly succeeded")
	}
	if got := searchIDs(t, db, "original"); len(got) != 1 || got[0] != v.ID {
		t.Fatal(got)
	}
	var version int
	if err := db.QueryRow("SELECT version FROM search_projection WHERE id = 1").Scan(&version); err != nil || version != searchProjectionVersion {
		t.Fatalf("%d %v", version, err)
	}
}

func TestSearchExcludesIndirectTagsAndStoredTranscripts(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "exclusions.db"))
	v := searchFixture(t, db, "document")
	people := NewPersonRepository(db)
	person, err := people.Create(ctx, "personnameunindexed")
	if err != nil {
		t.Fatal(err)
	}
	if err := people.SetVideo(ctx, v.ID, person.ID, true); err != nil {
		t.Fatal(err)
	}
	tag, err := video.NormalizeTagName("persontagunindexed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := people.AddTags(ctx, person.ID, []video.TagName{tag}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "transcript.json3")
	if err := os.WriteFile(path, []byte(`{"events":[{"tStartMs":0,"segs":[{"utf8":"transcriptunindexed"}]}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
  INSERT INTO transcripts (video_source_id, language, provenance, local_path, last_fetched_at)
  VALUES (?, 'fr', 'youtube_auto', ?, ?)
 `, v.Sources[0].ID, path, formatDate(time.Now())); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"personnameunindexed", "persontagunindexed", "transcriptunindexed"} {
		if got := searchIDs(t, db, q); len(got) != 0 {
			t.Fatalf("%s: %v", q, got)
		}
	}
	if err := RebuildSearch(ctx, db); err != nil {
		t.Fatal(err)
	}
	if got := searchIDs(t, db, "transcriptunindexed"); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestSearchUnicodeLimitsAndPrefixThreshold(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "unicode.db"))
	for _, example := range []struct {
		title, query string
		match        bool
	}{
		{"漢字研究所", "漢字研究", true},
		{"漢字研究所", "漢字", false},
		{"123456", "1234", true},
		{"123456", "123", false},
		{"élan", "e\u0301lan", true},
		{"Straße", "STRASSE", false},
		{"œuvre", "oeuvre", false},
		{"ＡＢＣＤ", "abcd", false},
	} {
		v := searchFixture(t, db, example.title)
		found := false
		for _, id := range searchIDs(t, db, example.query) {
			found = found || id == v.ID
		}
		if found != example.match {
			t.Errorf("%q / %q: %t", example.title, example.query, found)
		}
	}
}

func TestSearchInterruptedProjectionRollsBackWrittenDocuments(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "interrupted.db"))
	first := searchFixture(t, db, "first original")
	second := searchFixture(t, db, "second original")
	interrupted, cancel := context.WithCancel(ctx)
	tx, err := db.BeginTx(interrupted, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(interrupted, "DELETE FROM video_search"); err != nil {
		t.Fatal(err)
	}
	if err := rebuildSearchVideo(interrupted, tx, first.ID); err != nil {
		t.Fatal(err)
	}
	// Interrompre après une vraie écriture de projection, avant le document suivant.
	cancel()
	if err := rebuildSearchVideo(interrupted, tx, second.ID); err == nil {
		t.Fatal("interrupted reconstruction succeeded")
	}
	tx.Rollback()
	if got := searchIDs(t, db, "original"); len(got) != 2 || got[0] != first.ID || got[1] != second.ID {
		t.Fatal(got)
	}
}

// TestSearchCrashProcess sort volontairement sans rollback pour exercer le journal SQLite réel.
func TestSearchCrashProcess(t *testing.T) {
	path := os.Getenv("SILLAGE_SEARCH_CRASH_TEST_PATH")
	if path == "" {
		return
	}
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("DELETE FROM video_search; DELETE FROM search_projection"); err != nil {
		t.Fatal(err)
	}
	if err := rebuildSearchVideo(context.Background(), tx, 1); err != nil {
		t.Fatal(err)
	}
	os.Exit(19)
}

func TestSearchCrashRecoveryPreservesCompleteProjection(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "crash.db")
	db := openTestDB(t, path)
	searchFixture(t, db, "first original")
	searchFixture(t, db, "second original")
	db.Close()
	command := exec.Command(os.Args[0], "-test.run=^TestSearchCrashProcess$")
	command.Env = append(os.Environ(), "SILLAGE_SEARCH_CRASH_TEST_PATH="+path)
	err := command.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 19 {
		t.Fatalf("unexpected helper exit: %v", err)
	}
	// Lire avant Open empêche l'initialisation Go de masquer un journal mal récupéré.
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	var count, version int
	if err := raw.QueryRow("SELECT count(*) FROM video_search").Scan(&count); err != nil || count != 2 {
		t.Fatalf("%d %v", count, err)
	}
	if err := raw.QueryRow("SELECT version FROM search_projection WHERE id = 1").Scan(&version); err != nil || version != searchProjectionVersion {
		t.Fatalf("%d %v", version, err)
	}
	raw.Close()
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := searchIDs(t, reopened, "original"); len(got) != 2 {
		t.Fatal(got)
	}
}
