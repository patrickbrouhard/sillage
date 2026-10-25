package sqlite

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestSearchExcerptsAndMultipleSourceContributions(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "explain.db"))
	ctx := context.Background()
	input := video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{
		{Provider: "local", Title: "Alpha", Description: "Café description"},
		{Provider: "local", Title: "Kubernetes", Publisher: &video.Publisher{Provider: "local", ExternalID: "p", Name: "Gamma"}},
	}}
	v, err := NewVideoRepository(db).Create(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	content := "⟦sillage-search-0-start⟧ <script>danger</script> " + strings.Repeat("remplissage ", 100) + "café " + strings.Repeat("séparation ", 100) + "Kubernetes"
	if _, err := NewNoteRepository(db).Save(ctx, v.ID, content, 0, time.Now()); err != nil {
		t.Fatal(err)
	}
	service := search.NewService(NewSearchRepository(db))
	page, err := service.Search(ctx, "alpha cafe kube gamma", 1, "")
	if err != nil || len(page.Results) != 1 {
		t.Fatalf("%+v %v", page, err)
	}
	got := page.Results[0]
	if len(got.Sources) != 2 || !got.Sources[0].Title || !got.Sources[0].Description || !got.Sources[1].Title || !got.Sources[1].Publisher {
		t.Fatalf("%+v", got.Sources)
	}
	found := false
	for _, s := range got.NoteExcerpt {
		if s.Highlight {
			found = true
			if s.Text != "café" && s.Text != "Kubernetes" {
				t.Fatalf("bad highlight: %+v", s)
			}
		}
	}
	if !found {
		t.Fatal("no note match")
	}
	page, err = service.Search(ctx, "alpha", 1, "")
	if err != nil || len(page.Results[0].NoteExcerpt) != 0 {
		t.Fatalf("%+v %v", page, err)
	}
	page, err = service.Search(ctx, "cafe\u0301", 1, "")
	if err != nil || len(page.Results[0].NoteExcerpt) == 0 {
		t.Fatalf("%+v %v", page, err)
	}
	// Une sous-chaîne n'est jamais une preuve : Go ne doit pas expliquer Google.
	other := searchFixture(t, db, "Go", "Google")
	page, err = service.Search(ctx, "Go", 1, "")
	if err != nil || len(page.Results) != 1 || page.Results[0].Video.ID != other.ID || len(page.Results[0].Sources) != 1 || page.Results[0].Sources[0].SourceID != other.Sources[0].ID {
		t.Fatalf("%+v %v", page, err)
	}
}

func TestSearchMarkerCollisionsAndLiteralHTML(t *testing.T) {
	text := "⟦sillage-search-0-start⟧ ⟦sillage-search-1-end⟧ <b>café</b>"
	start, end := searchMarkers(text)
	if strings.Contains(text, start) || strings.Contains(text, end) {
		t.Fatal("collision")
	}
	segments := searchSegments("<b>"+start+"café"+end+"</b>", start, end)
	if len(segments) != 3 || segments[0].Text != "<b>" || segments[1].Text != "café" || !segments[1].Highlight || segments[2].Text != "</b>" {
		t.Fatalf("%+v", segments)
	}
}

func TestSearchBatchLoadsWithOneConnection(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "batch.db"))
	db.SetMaxOpenConns(1)
	for range 23 {
		searchFixture(t, db, "batch", "secondary")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
	defer cancel()
	page, err := search.NewService(NewSearchRepository(db)).Search(ctx, "batch secondary", 1, "")
	if err != nil || len(page.Results) != 20 || !page.HasMore {
		t.Fatalf("%+v %v", page, err)
	}
	for _, r := range page.Results {
		if len(r.Sources) != 2 {
			t.Fatalf("%+v", r)
		}
	}
}

// TestSearchExcerptKeeps64Tokens vérifie la fenêtre entière, même au-delà de 600 caractères.
func TestSearchExcerptKeeps64Tokens(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "excerpt64.db"))
	v := searchFixture(t, db, "Document")
	for _, count := range []int{64, 96} {
		words := make([]string, count)
		for i := range words {
			words[i] = fmt.Sprintf("contexteparticulierementlong%d", i)
		}
		words[30] = "correspondance"
		content := strings.Join(words, " ")
		revision := int64(0)
		if count == 96 {
			revision = 1
		}
		if _, err := NewNoteRepository(db).Save(ctx, v.ID, content, revision, time.Now()); err != nil {
			t.Fatal(err)
		}
		page, err := search.NewService(NewSearchRepository(db)).Search(ctx, "correspondance", 1, "")
		if err != nil || len(page.Results) != 1 {
			t.Fatalf("%+v %v", page, err)
		}
		var excerpt strings.Builder
		marked := false
		for _, segment := range page.Results[0].NoteExcerpt {
			excerpt.WriteString(segment.Text)
			marked = marked || segment.Highlight && segment.Text == "correspondance"
		}
		text := excerpt.String()
		if got := len(strings.Fields(strings.Trim(text, "…"))); got != 64 || !marked || len([]rune(text)) <= 600 {
			t.Fatalf("tokens=%d highlighted=%t runes=%d", got, marked, len([]rune(text)))
		}
		if count == 64 && text != content {
			t.Fatalf("excerpt lost content: %q", text)
		}
	}
}

func TestSearchCalloutOrderAfterProjectionUpgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	db := openTestDB(t, path)
	v := searchFixture(t, db, "Document")
	content := "Avant\n\n> [!quote] Alice\n> Kubernetes simplifie le déploiement.\n\nEntre\n\n> [!quote:tr](sillage://videos/1/sources/2?start_ms=3) Bob\n> PostgreSQL conserve les données.\n\nAprès"
	saved, err := NewNoteRepository(db).Save(ctx, v.ID, content, 0, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// Reproduire la projection précédente, sans modifier la note métier.
	if _, err := db.Exec("UPDATE video_search SET note = ? WHERE rowid = ?", "Alice Bob Avant Kubernetes simplifie le déploiement. Entre PostgreSQL conserve les données. Après", v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE search_projection SET version = 3"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, err := NewNoteRepository(reopened).Get(ctx, v.ID)
	if err != nil || got != saved.Note {
		t.Fatalf("note changed: %+v, %v", got, err)
	}
	page, err := search.NewService(NewSearchRepository(reopened)).Search(ctx, "Alice Kubernetes", 1, "")
	if err != nil || len(page.Results) != 1 {
		t.Fatalf("page = %+v, err = %v", page, err)
	}
	var excerpt strings.Builder
	for _, segment := range page.Results[0].NoteExcerpt {
		excerpt.WriteString(segment.Text)
	}
	want := "Avant Alice Kubernetes simplifie le déploiement. Entre Bob PostgreSQL conserve les données. Après"
	if text := strings.Join(strings.Fields(excerpt.String()), " "); text != want {
		t.Fatalf("excerpt = %q, want %q", text, want)
	}
	var version int
	if err := reopened.QueryRow("SELECT version FROM search_projection WHERE id = 1").Scan(&version); err != nil || version != searchProjectionVersion {
		t.Fatalf("version = %d, err = %v", version, err)
	}
}

func TestLimitSearchExcerpt(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		before, match, after string
	}{
		{"exact limit", strings.Repeat("a", 4090), "needle", ""},
		{"giant match", "", "needle" + strings.Repeat("x", 1000000), ""},
		{"late match", strings.Repeat("x", 1000000), "needle", ""},
		{"unicode", strings.Repeat("界", 5000), "éclair", strings.Repeat("🙂", 5000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			segments := []search.Segment{{Text: tc.before}, {Text: tc.match, Highlight: true}, {Text: tc.after}}
			got := limitSearchExcerpt(segments)
			var text, marked strings.Builder
			for _, segment := range got {
				if !utf8.ValidString(segment.Text) {
					t.Fatal("invalid UTF-8")
				}
				text.WriteString(segment.Text)
				if segment.Highlight {
					marked.WriteString(segment.Text)
				}
			}
			if marked.Len() == 0 || !strings.HasPrefix(tc.match, marked.String()) {
				t.Fatalf("lost match: %q", marked.String())
			}
			want := tc.before + tc.match + tc.after
			if utf8.RuneCountInString(want) <= 4096 {
				if text.String() != want {
					t.Fatal("bounded excerpt changed")
				}
			} else {
				if utf8.RuneCountInString(strings.Trim(text.String(), "…")) != 4096 {
					t.Fatal("incorrect bound")
				}
				if !strings.HasPrefix(text.String(), "…") && !strings.HasSuffix(text.String(), "…") {
					t.Fatal("missing ellipsis")
				}
				if !strings.Contains(want, strings.Trim(text.String(), "…")) {
					t.Fatal("context reordered")
				}
			}
		})
	}
}

func TestSearchExcerptGiantTokens(t *testing.T) {
	for _, content := range []string{
		"needle" + strings.Repeat("x", 999994),
		strings.Repeat("x", 1000000) + " needle",
	} {
		db := openTestDB(t, filepath.Join(t.TempDir(), "giant.db"))
		ctx := context.Background()
		v := searchFixture(t, db, "Document")
		saved, err := NewNoteRepository(db).Save(ctx, v.ID, content, 0, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		page, err := search.NewService(NewSearchRepository(db)).Search(ctx, "needle", 1, "")
		if err != nil || len(page.Results) != 1 || page.Total != 1 {
			t.Fatalf("search failed: %v", err)
		}
		length, highlighted := 0, false
		for _, segment := range page.Results[0].NoteExcerpt {
			if !utf8.ValidString(segment.Text) {
				t.Fatal("invalid UTF-8")
			}
			length += utf8.RuneCountInString(segment.Text)
			highlighted = highlighted || segment.Highlight && strings.Contains(segment.Text, "needle")
		}
		if length > 4098 || !highlighted {
			t.Fatalf("length=%d highlighted=%t", length, highlighted)
		}
		note, err := NewNoteRepository(db).Get(ctx, v.ID)
		if err != nil || note != saved.Note {
			t.Fatal("note changed")
		}
	}
}

// BenchmarkLimitSearchExcerpt mesure le coût du bornage seul, hors extraction FTS.
func BenchmarkLimitSearchExcerpt(b *testing.B) {
	for _, size := range []int{10000, 1000000} {
		b.Run(fmt.Sprintf("late_match_%d", size), func(b *testing.B) {
			segments := []search.Segment{
				{Text: strings.Repeat("x", size)},
				{Text: "needle", Highlight: true},
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = limitSearchExcerpt(segments)
			}
		})
	}
}
