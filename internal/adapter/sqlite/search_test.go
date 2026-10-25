package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// searchFixture crée des sources locales déterministes sans acquisition distante.
func searchFixture(t *testing.T, db *sql.DB, titles ...string) video.Video {
	t.Helper()
	input := video.Video{CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	for _, title := range titles {
		input.Sources = append(input.Sources, video.VideoSource{Provider: "local", Title: title})
	}
	v, err := NewVideoRepository(db).Create(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// searchIDs traverse le même service que REST.
func searchIDs(t *testing.T, db *sql.DB, q string) []video.VideoID {
	t.Helper()
	page, err := search.NewService(NewSearchRepository(db)).Search(context.Background(), q, 1, "")
	if err != nil {
		t.Fatalf("search %q: %v", q, err)
	}
	ids := []video.VideoID{}
	for _, r := range page.Results {
		ids = append(ids, r.Video.ID)
	}
	return ids
}

func TestSearchTokenizerAndBooleanRules(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "search.db"))
	fixtures := []struct {
		title   string
		queries []string
		absent  []string
	}{
		{"Kubernetes Google API SQL net", []string{"kube", "API SQL net", "\"kube\""}, []string{"Go", "AP", "SQ", "ne"}},
		{"Go node.js", []string{"Go", "node.js", "node js"}, []string{"Google", "nodes"}},
		{"C++", []string{"C++"}, []string{"C#", "C"}},
		{"C#", []string{"C#"}, []string{"C++", "C"}},
		{"C", []string{"C"}, []string{"C++", "C#"}},
		{"Café CAFÉ cafe\u0301", []string{"café", "CAFE", "cafe\u0301"}, nil},
		{"#devops a+b a + b", []string{"#devops", "a+b", "a b"}, []string{"devops", "a+b+c"}},
	}
	for _, f := range fixtures {
		v := searchFixture(t, db, f.title)
		for _, q := range f.queries {
			ids := searchIDs(t, db, q)
			found := false
			for _, id := range ids {
				found = found || id == v.ID
			}
			if !found {
				t.Errorf("%q missing for %q: %v", f.title, q, ids)
			}
		}
		for _, q := range f.absent {
			for _, id := range searchIDs(t, db, q) {
				if id == v.ID {
					t.Errorf("%q unexpectedly matches %q", f.title, q)
				}
			}
		}
	}
	for _, q := range []string{"", " \" ! * : ( ) - ", "+++ ###", "kube OR missing", "kube NOT missing"} {
		if got := searchIDs(t, db, q); len(got) != 0 {
			t.Errorf("%q: %v", q, got)
		}
	}
	for _, q := range []string{strings.Repeat("x", search.MaxQueryBytes+1), strings.Repeat("go ", search.MaxTerms+1)} {
		_, err := search.NewService(NewSearchRepository(db)).Search(context.Background(), q, 1, "")
		if !errors.Is(err, search.ErrInvalidInput) {
			t.Fatal(err)
		}
	}
}

func TestSearchMutationsAndRollback(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "search.db"))
	v := searchFixture(t, db, "alpha", "beta")
	assert := func(q string, n int) {
		t.Helper()
		if got := searchIDs(t, db, q); len(got) != n {
			t.Fatalf("%q: %v", q, got)
		}
	}
	assert("alpha beta", 1)
	tags := video.NewTagService(NewTagRepository(db))
	direct, err := tags.Add(ctx, v.ID, []string{"gamma"})
	if err != nil {
		t.Fatal(err)
	}
	notes := NewNoteRepository(db)
	saved, err := notes.Save(ctx, v.ID, "# delta", 0, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	assert("alpha beta gamma delta", 1)
	same, err := notes.Save(ctx, v.ID, "# delta", 1, time.Now().Add(time.Hour))
	if err != nil || !reflect.DeepEqual(saved.Note, same.Note) {
		t.Fatalf("%+v %v", same, err)
	}
	if _, err := notes.Save(ctx, v.ID, "conflicted", 0, time.Now()); !errors.Is(err, note.ErrConflict) {
		t.Fatal(err)
	}
	assert("conflicted", 0)
	pubs := NewPublisherRepository(db)
	p, err := pubs.CreateOrFind(ctx, video.Publisher{Provider: "local", ExternalID: "account", Name: "epsilon"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pubs.SetSource(ctx, v.ID, v.Sources[1].ID, &p.Publisher.ID); err != nil {
		t.Fatal(err)
	}
	assert("alpha epsilon delta", 1)
	indirect, _ := video.NormalizeTagName("indirect")
	if _, err := pubs.AddTags(ctx, p.Publisher.ID, []video.TagName{indirect}); err != nil {
		t.Fatal(err)
	}
	assert("indirect", 0)
	if err := pubs.SetSource(ctx, v.ID, v.Sources[1].ID, nil); err != nil {
		t.Fatal(err)
	}
	assert("epsilon", 0)
	if err := NewTagRepository(db).Remove(ctx, v.ID, direct[0].ID); err != nil {
		t.Fatal(err)
	}
	assert("gamma", 0)
	// Une projection indisponible annule chaque mutation métier.
	if _, err := db.Exec("ALTER TABLE video_search RENAME TO broken_search"); err != nil {
		t.Fatal(err)
	}
	if _, err := notes.Save(ctx, v.ID, "lost", 1, time.Now()); err == nil {
		t.Fatal("save committed without index")
	}
	got, err := notes.Get(ctx, v.ID)
	if err != nil || !reflect.DeepEqual(got, saved.Note) {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := tags.Add(ctx, v.ID, []string{"losttag"}); err == nil {
		t.Fatal("tags committed")
	}
	if err := pubs.SetSource(ctx, v.ID, v.Sources[0].ID, &p.Publisher.ID); err == nil {
		t.Fatal("publisher committed")
	}
	if _, err := NewVideoRepository(db).Create(ctx, sampleVideo("lost")); err == nil {
		t.Fatal("video committed")
	}
	if _, err := db.Exec("ALTER TABLE broken_search RENAME TO video_search"); err != nil {
		t.Fatal(err)
	}
	assert("lost losttag", 0)
	assert("delta", 1)
}

func TestSearchMarkdownProjection(t *testing.T) {
	input := "# Titre\n\nParagraphe **fort** et [libellé](https://destination.invalid/secret) ![alternatif](image-secret.png)\n\n- liste\n\n| Colonne | Valeur |\n|---|---|\n| cellule | tableau |\n\n> [!quote] Attribution\n> Corps\n\n> [!quote:tr](sillage://videos/1/sources/2?start_ms=3) Citation titre\n> citation\n\n`inline`\n\n~~~shell-secret\nls /tmp/fichier C++\n~~~\n\n<div>\nhtml-secret\n</div>\n\nvisible <b>contenu</b>"
	got := markdownSearchText(input)
	for _, word := range []string{"Titre", "Paragraphe", "fort", "libellé", "alternatif", "liste", "cellule", "tableau", "Attribution", "Corps", "Citation titre", "citation", "inline", "ls /tmp/fichier C++", "visible", "contenu"} {
		if !strings.Contains(got, word) {
			t.Errorf("missing %q in %q", word, got)
		}
	}
	for _, word := range []string{"destination", "image-secret", "shell-secret", "html-secret", "sillage://", "start_ms", "[!quote", "**"} {
		if strings.Contains(got, word) {
			t.Errorf("leaked %q in %q", word, got)
		}
	}
}

func TestSearchProjectionMigrationRecoveryAndConcurrentOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	names, _ := fs.Glob(migrationFiles, "migrations/*.sql")
	for _, name := range names[:9] {
		data, _ := migrationFiles.ReadFile(name)
		files[name] = &fstest.MapFile{Data: data}
	}
	if err := migrate(ctx, db, files); err != nil {
		t.Fatal(err)
	}
	date := "2020-01-01T00:00:00.000Z"
	for _, sql := range []string{
		fmt.Sprintf("INSERT INTO videos (id,created_at) VALUES (1,'%s')", date),
		"INSERT INTO video_sources (video_id,provider,title) VALUES (1,'local','legacy')",
		fmt.Sprintf("INSERT INTO notes (video_id,content_md,created_at,updated_at,revision) VALUES (1,'# Café\r\n','%s','%s',7)", date, date),
	} {
		if _, err := db.Exec(sql); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			opened, err := Open(ctx, path)
			if err != nil {
				t.Error(err)
			} else {
				opened.Close()
			}
		})
	}
	wg.Wait()
	db = openTestDB(t, path)
	if got := searchIDs(t, db, "legacy café"); len(got) != 1 {
		t.Fatal(got)
	}
	before, err := NewNoteRepository(db).Get(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := RebuildSearch(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := RebuildSearch(canceled, db); err == nil {
		t.Fatal("canceled rebuild succeeded")
	}
	// Simuler une interruption au milieu de la projection : transaction et marqueur disparaissent ensemble.
	tx, _ := db.BeginTx(ctx, nil)
	tx.Exec("DELETE FROM search_projection")
	tx.Exec("DELETE FROM video_search")
	tx.Rollback()
	after, err := NewNoteRepository(db).Get(ctx, 1)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("%+v %v", after, err)
	}
	if got := searchIDs(t, db, "legacy café"); len(got) != 1 {
		t.Fatal(got)
	}
}

func TestSearchPagination(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "search.db"))
	for range 41 {
		searchFixture(t, db, "common")
	}
	service := search.NewService(NewSearchRepository(db))
	seen := map[video.VideoID]bool{}
	for page := 1; page <= 3; page++ {
		got, err := service.Search(context.Background(), "common", page, "")
		want := 20
		if page == 3 {
			want = 1
		}
		if err != nil || len(got.Results) != want || got.HasMore != (page < 3) {
			t.Fatalf("%+v %v", got, err)
		}
		for _, r := range got.Results {
			if seen[r.Video.ID] {
				t.Fatal("duplicate")
			}
			seen[r.Video.ID] = true
		}
	}
}
