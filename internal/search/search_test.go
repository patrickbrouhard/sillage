package search

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// recordingRepository vérifie le contrat transmis au moteur, sans dépendance SQLite.
type recordingRepository struct {
	calls int
	query string
	page  int
	sort  Sort
}

func (r *recordingRepository) Search(_ context.Context, query string, page int, sort Sort) (Page, error) {
	r.calls++
	r.query, r.page, r.sort = query, page, sort
	return Page{Total: 42}, nil
}

func TestSearchSortAndValidation(t *testing.T) {
	for _, sort := range []Sort{"", SortRelevance, SortNewest} {
		t.Run(string(sort), func(t *testing.T) {
			repository := &recordingRepository{}
			page, err := NewService(repository).Search(context.Background(), "kube", 2, sort)
			want := sort
			if want == "" {
				want = SortRelevance
			}
			if err != nil || page.Total != 42 || repository.calls != 1 || repository.query != "kube" || repository.page != 2 || repository.sort != want {
				t.Fatalf("page=%+v repository=%+v error=%v", page, repository, err)
			}
		})
	}
	for _, input := range []struct {
		query string
		page  int
		sort  Sort
	}{
		{"kube", 1, "unknown"},
		{"", 1, "Newest"},
		{"", 1, " relevance"},
		{"kube", 0, SortNewest},
		{"kube", MaxPage + 1, SortRelevance},
		{string([]byte{0xff}), 1, SortNewest},
		{strings.Repeat("x", MaxQueryBytes+1), 1, SortRelevance},
	} {
		repository := &recordingRepository{}
		_, err := NewService(repository).Search(context.Background(), input.query, input.page, input.sort)
		if !errors.Is(err, ErrInvalidInput) || repository.calls != 0 {
			t.Fatalf("input=%+v calls=%d error=%v", input, repository.calls, err)
		}
	}
}
