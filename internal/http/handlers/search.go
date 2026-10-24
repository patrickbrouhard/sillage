package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/search"
)

// SearchService est le même cas d'usage que celui des futures interfaces non HTTP.
type SearchService interface {
	Search(context.Context, string, int) (search.Page, error)
}

// SearchHandler valide la forme REST avant d'appeler le service applicatif.
type SearchHandler struct{ service SearchService }

// NewSearchHandler assemble l'adaptation REST.
func NewSearchHandler(service SearchService) *SearchHandler { return &SearchHandler{service: service} }

// Get retourne une page fixe sans publier scores SQLite ni expression FTS.
func (h *SearchHandler) Get(w http.ResponseWriter, r *http.Request) {
	requestlog.Route(r, "/api/v1/search")
	params, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, r, 400, "bad_request", "invalid search parameters")
		return
	}
	for key, values := range params {
		if (key != "q" && key != "page") || len(values) != 1 {
			writeError(w, r, 400, "bad_request", "invalid search parameters")
			return
		}
	}
	page := 1
	if values, ok := params["page"]; ok {
		page, err = strconv.Atoi(values[0])
		if err != nil {
			writeError(w, r, 400, "bad_request", "invalid search page")
			return
		}
	}
	result, err := h.service.Search(r.Context(), params.Get("q"), page)
	if err != nil {
		if errors.Is(err, search.ErrInvalidInput) {
			writeError(w, r, 400, "bad_request", "invalid search parameters")
		} else {
			respondError(w, r, err)
		}
		return
	}
	type item struct {
		Video       videoResponse        `json:"video"`
		NoteExcerpt []search.Segment     `json:"note_excerpt"`
		Sources     []search.SourceMatch `json:"source_matches"`
	}
	items := make([]item, 0, len(result.Results))
	for _, result := range result.Results {
		items = append(items, item{toVideoResponse(result.Video), result.NoteExcerpt, result.Sources})
	}
	writeJSON(w, r, 200, struct {
		Results []item `json:"results"`
		Page    int    `json:"page"`
		HasMore bool   `json:"has_more"`
		Total   int64  `json:"total"`
	}{items, page, result.HasMore, result.Total})
}
