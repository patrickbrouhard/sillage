package sqlite

import (
	"context"
	"database/sql"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// SearchRepository interroge la projection transactionnelle FTS5.
type SearchRepository struct{ db *sql.DB }

// NewSearchRepository utilise une base ouverte et initialisée par Open.
func NewSearchRepository(db *sql.DB) *SearchRepository { return &SearchRepository{db: db} }

var _ search.Repository = (*SearchRepository)(nil)

// searchTerms délègue la segmentation et la normalisation au tokenizer réel de SQLite.
// Les tables temporaires appartiennent exclusivement à la connexion réservée.
func searchTerms(ctx context.Context, conn *sql.Conn, query string) ([]string, error) {
	for _, statement := range []string{
		`CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_input USING fts5(text, tokenize = "unicode61 remove_diacritics 2 tokenchars '+#'")`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_tokens USING fts5vocab(search_input, instance)`,
		"DELETE FROM temp.search_input",
	} {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return nil, err
		}
	}
	if _, err := conn.ExecContext(ctx, "INSERT INTO temp.search_input (text) VALUES (?)", query); err != nil {
		return nil, err
	}
	rows, err := conn.QueryContext(ctx, "SELECT term FROM temp.search_tokens ORDER BY offset")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	terms := []string{}
	count := 0
	for rows.Next() {
		var token string
		if err := rows.Scan(&token); err != nil {
			return nil, err
		}
		count++
		if count > search.MaxTerms {
			return nil, search.ErrInvalidInput
		}
		letters := 0
		plain := true
		for _, r := range token {
			if unicode.IsLetter(r) || unicode.IsNumber(r) {
				letters++
			} else {
				plain = false
			}
		}
		if letters == 0 {
			continue
		}
		// Chaque token est cité séparément : aucun opérateur ou phrase utilisateur.
		term := `"` + strings.ReplaceAll(token, `"`, `""`) + `"`
		if plain && letters >= 4 {
			term += "*"
		}
		terms = append(terms, term)
	}
	return terms, rows.Err()
}

// Search garde index et relations dans un court instantané de lecture différé.
// BEGIN est explicite ici car BeginTx utilise le verrou immédiat réservé aux écritures.
func (r *SearchRepository) Search(ctx context.Context, query string, page int) (search.Page, error) {
	result := search.Page{Results: []search.Result{}}
	if !utf8.ValidString(query) || len(query) > search.MaxQueryBytes || page < 1 || page > search.MaxPage {
		return result, search.ErrInvalidInput
	}
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return result, err
	}
	defer conn.Close()
	terms, err := searchTerms(ctx, conn, query)
	if err != nil {
		return result, err
	}
	if len(terms) == 0 {
		return result, nil
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		return result, err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	// Compter séparément conserve le total sur une page vide, sans calcul BM25.
	// Ce premier SELECT fixe l'instantané différé commun à la page et aux explications.
	expression := strings.Join(terms, " AND ")
	if err := conn.QueryRowContext(ctx, `
  SELECT
   COUNT(*)
  FROM video_search
  WHERE video_search MATCH ?
 `, expression).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := conn.QueryContext(ctx, `
  SELECT
   rowid
  FROM video_search
  WHERE video_search MATCH ?
  ORDER BY
   bm25(video_search, 8.0, 10.0, 3.0, 2.0, 0.5),
   rowid
  LIMIT ? OFFSET ?
 `, expression, search.PageSize+1, (page-1)*search.PageSize)
	if err != nil {
		return result, err
	}
	ids := []video.VideoID{}
	for rows.Next() {
		var id video.VideoID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	result.HasMore = len(ids) > search.PageSize
	if result.HasMore {
		ids = ids[:search.PageSize]
	}
	if len(ids) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	videos, err := queryVideos(ctx, conn, "v.id IN ("+strings.Join(placeholders, ",")+")", args...)
	if err != nil {
		return result, err
	}
	byID := map[video.VideoID]video.Video{}
	for _, v := range videos {
		byID[v.ID] = v
	}
	for _, id := range ids {
		result.Results = append(result.Results, search.Result{Video: byID[id], NoteExcerpt: []search.Segment{}, Sources: []search.SourceMatch{}})
	}
	if err := explainSearch(ctx, conn, result.Results, terms, strings.Join(placeholders, ","), args); err != nil {
		return result, err
	}
	return result, nil
}
