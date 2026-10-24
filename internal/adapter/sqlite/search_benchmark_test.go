package sqlite

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/search"
)

// BenchmarkSearchLibrary mesure une projection de 2 000 vidéos, notes et descriptions longues.
// Les fixtures SQL originales sont préparées hors mesure ; aucun fichier personnel n'est ouvert.
func BenchmarkSearchLibrary(b *testing.B) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(b.TempDir(), "benchmark.db"))
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		b.Fatal(err)
	}
	date := formatDate(time.Now())
	note := "# Atelier\n\n" + strings.Repeat("Texte technique avec commandes et chemins /tmp/demo.\n", 180)
	description := strings.Repeat("Description de la source pour la bibliothèque. ", 120)
	for i := 1; i <= 2000; i++ {
		title := fmt.Sprintf("Atelier %d", i)
		if i%10 == 0 {
			title += " Kubernetes"
		}
		if _, err := tx.Exec("INSERT INTO videos (id, created_at) VALUES (?, ?)", i, date); err != nil {
			b.Fatal(err)
		}
		if _, err := tx.Exec(`
   INSERT INTO video_sources (video_id, provider, title, description)
   VALUES (?, 'local', ?, ?), (?, 'local', ?, ?)
  `, i, title, description, i, title, description); err != nil {
			b.Fatal(err)
		}
		if _, err := tx.Exec(`
   INSERT INTO notes (video_id, content_md, created_at, updated_at, revision)
   VALUES (?, ?, ?, ?, 1)
  `, i, note, date, date); err != nil {
			b.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	started := time.Now()
	if err := RebuildSearch(ctx, db); err != nil {
		b.Fatal(err)
	}
	rebuild := time.Since(started)
	started = time.Now()
	for i := range 20 {
		if _, err := NewNoteRepository(db).Save(ctx, 1, note+fmt.Sprintf("\nRévision %d", i), int64(i+1), time.Now()); err != nil {
			b.Fatal(err)
		}
	}
	save := time.Since(started) / 20
	service := search.NewService(NewSearchRepository(db))

	for _, scenario := range []struct {
		name  string
		query string
		page  int
		count int
		more  bool
		total int64
	}{
		{"selective", "kube technique", 1, 20, true, 200},
		{"frequent", "technique", 1, 20, true, 2000},
		{"distant", "technique", 90, 20, true, 2000},
		{"empty", "technique", 101, 0, false, 2000},
	} {
		b.Run(scenario.name, func(b *testing.B) {
			for range b.N {
				page, err := service.Search(ctx, scenario.query, scenario.page)
				if err != nil || len(page.Results) != scenario.count || page.HasMore != scenario.more || page.Total != scenario.total {
					b.Fatalf("page: %d, %v", len(page.Results), err)
				}
			}
		})
	}
	b.ReportMetric(float64(rebuild.Microseconds())/1000, "rebuild-ms")
	b.ReportMetric(float64(save.Microseconds())/1000, "save-ms")
	b.ReportMetric(2000, "videos")
}
