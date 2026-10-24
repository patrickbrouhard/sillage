package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// TestSearchREST valide le transport contre le vrai service et une base temporaire.
func TestSearchREST(t *testing.T) {
	base, db := knowledgeAPI(t)
	h := api.WithSearch(base, search.NewService(sqlite.NewSearchRepository(db)))
	for _, query := range []string{"q=Original", "q=Original&page=1", "q=", "q=%22%20*%20%22", "q=unknown"} {
		res := request(h, "GET", "/api/v1/search?"+query, "", "")
		if res.Code != 200 {
			t.Fatalf("%s: %d %s", query, res.Code, res.Body.String())
		}
		var body struct {
			Results []json.RawMessage `json:"results"`
			HasMore bool              `json:"has_more"`
			Total   *int64            `json:"total"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || body.Results == nil || body.Total == nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{"q=a&q=b", "page=1&page=2", "page=0", "page=-1", "page=1001", "page=", "page=abc", "q=%ff", "q=%zz", "unknown=x", "q=" + strings.Repeat("a", 1025), "q=" + strings.Repeat("go+", 33)} {
		res := request(h, "GET", "/api/v1/search?"+query, "", "")
		// + est un espace URL : ce cas couvre bien 33 termes courts.
		if res.Code != 400 {
			t.Fatalf("%s: %d", query, res.Code)
		}
	}
	if _, err := search.NewService(sqlite.NewSearchRepository(db)).Search(context.Background(), "Original", 1); err != nil {
		t.Fatal(err)
	}
}

func TestSearchRESTExactTotalOnPartialAndEmptyPages(t *testing.T) {
	base, db := knowledgeAPI(t)
	ctx := context.Background()
	for range 41 {
		_, err := sqlite.NewVideoRepository(db).Create(ctx, video.Video{
			CreatedAt: time.Now(),
			Sources: []video.VideoSource{
				{Provider: "local", Title: "alpha"},
				{Provider: "local", Title: "beta"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := sqlite.NewVideoRepository(db).Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "local", Title: "alpha"}}})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.WithSearch(base, search.NewService(sqlite.NewSearchRepository(db)))
	for number, count := range []int{20, 20, 1, 0} {
		response := request(handler, "GET", fmt.Sprintf("/api/v1/search?q=alpha+beta&page=%d", number+1), "", "")
		var body struct {
			Results []json.RawMessage
			Total   int64
			HasMore bool `json:"has_more"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != 200 || body.Total != 41 || len(body.Results) != count || body.HasMore != (number < 2) {
			t.Fatalf("%d %s", response.Code, response.Body.String())
		}
	}
	for _, example := range []struct {
		query string
		total int64
	}{
		{"Original", 1}, {"absent", 0}, {"", 0}, {"%22+*+%22", 0},
	} {
		response := request(handler, "GET", "/api/v1/search?q="+example.query, "", "")
		var body struct{ Total *int64 }
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Total == nil || *body.Total != example.total {
			t.Fatalf("%s %v", response.Body.String(), err)
		}
	}
}
