package sqlite

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestSearchTotalAcrossPagesUsesAndAndCountsVideos(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "total.db"))
	for range 41 {
		searchFixture(t, db, "alpha", "beta", "alpha")
	}
	searchFixture(t, db, "alpha")
	service := search.NewService(NewSearchRepository(db))
	for number, count := range []int{20, 20, 1, 0} {
		page, err := service.Search(context.Background(), "alpha beta", number+1, "")
		if err != nil || page.Total != 41 || len(page.Results) != count || page.HasMore != (number < 2) {
			t.Fatalf("page %d: total=%d results=%d more=%t error=%v", number+1, page.Total, len(page.Results), page.HasMore, err)
		}
	}
	for _, query := range []string{"absent", "", " \" * + # : "} {
		page, err := service.Search(context.Background(), query, 10, "")
		if err != nil || page.Total != 0 || len(page.Results) != 0 || page.HasMore {
			t.Fatalf("%q: %+v %v", query, page, err)
		}
	}
}

func TestSearchTotalUpdatesAfterNoteAndTagMutations(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "mutations.db"))
	v := searchFixture(t, db, "alpha", "beta")
	service := search.NewService(NewSearchRepository(db))
	check := func(query string, total int64) {
		t.Helper()
		for _, number := range []int{1, 999} {
			page, err := service.Search(ctx, query, number, "")
			count := int(total)
			if number == 999 {
				count = 0
			}
			if err != nil || page.Total != total || len(page.Results) != count || page.HasMore {
				t.Fatalf("%q page %d: %+v %v", query, number, page, err)
			}
		}
	}
	notes := NewNoteRepository(db)
	if _, err := notes.Save(ctx, v.ID, "Café C++ Kubernetes", 0, time.Now()); err != nil {
		t.Fatal(err)
	}
	tags := video.NewTagService(NewTagRepository(db))
	added, err := tags.Add(ctx, v.ID, []string{"direct"})
	if err != nil {
		t.Fatal(err)
	}
	check("alpha beta cafe\u0301 C++ kube direct", 1)
	check("C#", 0)
	if err := tags.Remove(ctx, v.ID, added[0].ID); err != nil {
		t.Fatal(err)
	}
	check("cafe direct", 0)
	if _, err := notes.Save(ctx, v.ID, "C#", 1, time.Now()); err != nil {
		t.Fatal(err)
	}
	check("C++", 0)
	check("C#", 1)
}

func TestSearchWithoutTokensDoesNotMatchOrCount(t *testing.T) {
	db := openTestDB(t, filepath.Join(t.TempDir(), "no-match.db"))
	if _, err := db.Exec("DROP TABLE video_search"); err != nil {
		t.Fatal(err)
	}
	page, err := search.NewService(NewSearchRepository(db)).Search(context.Background(), " * \" +# ", 1, "")
	if err != nil || page.Total != 0 || len(page.Results) != 0 || page.HasMore {
		t.Fatalf("%+v %v", page, err)
	}
}

func TestSearchTotalAndPageShareSnapshotDuringNoteChanges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db := openTestDB(t, filepath.Join(t.TempDir(), "snapshot.db"))
	v := searchFixture(t, db, "stable")
	var group sync.WaitGroup
	group.Go(func() {
		for i := range 30 {
			content := "needle"
			if i%2 == 0 {
				content = "other"
			}
			if _, err := NewNoteRepository(db).Save(ctx, v.ID, content, int64(i), time.Now()); err != nil {
				t.Error(err)
				return
			}
		}
	})
	for _, sort := range []search.Sort{search.SortRelevance, search.SortNewest} {
		group.Go(func() {
			for range 30 {
				page, err := search.NewService(NewSearchRepository(db)).Search(ctx, "needle", 1, sort)
				if err != nil {
					t.Error(err)
					return
				}
				if page.Total != int64(len(page.Results)) || page.HasMore || (len(page.Results) == 1 && len(page.Results[0].NoteExcerpt) == 0) {
					t.Errorf("inconsistent snapshot: total=%d results=%d", page.Total, len(page.Results))
					return
				}
			}
		})
	}
	group.Wait()
}
