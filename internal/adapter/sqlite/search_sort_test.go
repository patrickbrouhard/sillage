package sqlite

import (
	"context"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestSearchSortAcrossPagesAndExplanations(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "sort.db"))
	service := search.NewService(NewSearchRepository(db))
	var videos []video.Video
	for i := range 45 {
		// Les dates ne suivent pas les IDs et plusieurs vidéos partagent la même milliseconde.
		v, err := NewVideoRepository(db).Create(ctx, video.Video{
			CreatedAt: time.Date(2026, 1, 1, (i*17)%11, 0, 0, 123000000, time.UTC),
			Sources: []video.VideoSource{
				{Provider: "local", Title: "alpha"},
				{Provider: "local", Title: "secondary", Description: "beta"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := NewNoteRepository(db).Save(ctx, v.ID, "# gamma", 0, time.Now()); err != nil {
			t.Fatal(err)
		}
		if _, err := video.NewTagService(NewTagRepository(db)).Add(ctx, v.ID, []string{"alpha"}); err != nil {
			t.Fatal(err)
		}
		videos = append(videos, v)
	}
	searchFixture(t, db, "alpha gamma")
	// Le parcours sans choix fournit la référence ; les sous-tests suivants comparent par identité.
	explanations := map[video.VideoID]search.Result{}
	for _, sort := range []search.Sort{"", search.SortRelevance, search.SortNewest} {
		t.Run(string(sort), func(t *testing.T) {
			expected := slices.Clone(videos)
			if sort == search.SortNewest {
				slices.SortFunc(expected, func(a, b video.Video) int {
					if a.CreatedAt.After(b.CreatedAt) {
						return -1
					}
					if a.CreatedAt.Before(b.CreatedAt) {
						return 1
					}
					if a.ID > b.ID {
						return -1
					}
					if a.ID < b.ID {
						return 1
					}
					return 0
				})
			}
			var gotIDs []video.VideoID
			for number, count := range []int{20, 20, 5, 0} {
				page, err := service.Search(ctx, "alpha beta gamma", number+1, sort)
				if err != nil || page.Total != 45 || len(page.Results) != count || page.HasMore != (number < 2) {
					t.Fatalf("sort=%q page=%d: %+v error=%v", sort, number+1, page, err)
				}
				for _, result := range page.Results {
					gotIDs = append(gotIDs, result.Video.ID)
					if sort == "" {
						if len(result.NoteExcerpt) == 0 || len(result.Sources) != 2 {
							t.Fatalf("missing explanations: %+v", result)
						}
						explanations[result.Video.ID] = result
					} else if !reflect.DeepEqual(explanations[result.Video.ID], result) {
						t.Fatalf("different result for video %d", result.Video.ID)
					}
				}
			}
			for i, v := range expected {
				if gotIDs[i] != v.ID {
					t.Fatalf("position %d: got %v, want video %d", i, gotIDs, v.ID)
				}
			}
		})
	}
}

func TestSearchNewestDiffersFromRelevance(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t, filepath.Join(t.TempDir(), "relevance.db"))
	create := func(date time.Time, source video.VideoSource) video.Video {
		t.Helper()
		v, err := NewVideoRepository(db).Create(ctx, video.Video{CreatedAt: date, Sources: []video.VideoSource{source}})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	date := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	recent := create(date.Add(time.Hour), video.VideoSource{Provider: "local", Title: "Présentation", Description: "Kubernetes"})
	old := create(date, video.VideoSource{Provider: "local", Title: "Kubernetes"})
	for range 12 {
		searchFixture(t, db, "sans rapport")
	}
	service := search.NewService(NewSearchRepository(db))
	for sort, first := range map[search.Sort]video.VideoID{search.SortRelevance: old.ID, search.SortNewest: recent.ID} {
		page, err := service.Search(ctx, "kube", 1, sort)
		if err != nil || page.Total != 2 || len(page.Results) != 2 || page.Results[0].Video.ID != first {
			t.Fatalf("sort=%q: %+v %v", sort, page, err)
		}
	}
}
