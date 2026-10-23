package http_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/search"
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
		}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || body.Results == nil {
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
