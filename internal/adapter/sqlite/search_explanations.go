package sqlite

import (
	"context"
	"database/sql"
	"strconv"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// explainSearch lit la page par lots dans son instantané, puis interroge le même tokenizer.
// Le OU explique les contributions partielles ; le ET a déjà sélectionné les vidéos.
func explainSearch(ctx context.Context, conn *sql.Conn, results []search.Result, terms []string, placeholders string, ids []any) error {
	rows, err := conn.QueryContext(ctx, `
  SELECT
   rowid,
   note
  FROM video_search
  WHERE rowid IN (`+placeholders+`)
 `, ids...)
	if err != nil {
		return err
	}
	text := strings.Builder{}
	indices := map[video.VideoID]int{}
	for i, result := range results {
		indices[result.Video.ID] = i
		for _, source := range result.Video.Sources {
			text.WriteString(source.Title)
			text.WriteString(source.Description)
			if source.Publisher != nil {
				text.WriteString(source.Publisher.Name)
			}
		}
	}
	for rows.Next() {
		var id video.VideoID
		var note string
		if err := rows.Scan(&id, &note); err != nil {
			rows.Close()
			return err
		}
		text.WriteString(note)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// Choisir des délimiteurs absents de tout texte évite toute collision, même malveillante.
	start, end := searchMarkers(text.String())
	args := []any{start, end, strings.Join(terms, " OR ")}
	args = append(args, ids...)
	rows, err = conn.QueryContext(ctx, `
  SELECT
   rowid,
   snippet(video_search, 2, ?, ?, '…', 32)
  FROM video_search
  WHERE video_search MATCH ?
   AND rowid IN (`+placeholders+`)
 `, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id video.VideoID
		var excerpt string
		if err := rows.Scan(&id, &excerpt); err != nil {
			rows.Close()
			return err
		}
		// snippet sur une colonne sans correspondance peut quand même retourner du texte.
		if strings.Contains(excerpt, start) {
			results[indices[id]].NoteExcerpt = limitSearchExcerpt(searchSegments(excerpt, start, end))
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, statement := range []string{
		`CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_evidence USING fts5(
   title, description, publisher, video_id UNINDEXED,
   tokenize = "unicode61 remove_diacritics 2 tokenchars '+#'"
  )`,
		"DELETE FROM temp.search_evidence",
	} {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	// Une insertion SELECT traite toutes les sources de la page, sans requête par vidéo/source.
	if _, err := conn.ExecContext(ctx, `
  INSERT INTO temp.search_evidence (rowid, title, description, publisher, video_id)
  SELECT
   s.id,
   s.title,
   COALESCE(s.description, ''),
   COALESCE(p.name, ''),
   s.video_id
  FROM video_sources s
  LEFT JOIN publishers p
   ON p.id = s.publisher_id
  WHERE s.video_id IN (`+placeholders+`)
 `, ids...); err != nil {
		return err
	}
	rows, err = conn.QueryContext(ctx, `
  SELECT
   rowid,
   video_id,
   highlight(search_evidence, 0, ?, ?),
   highlight(search_evidence, 1, ?, ?),
   highlight(search_evidence, 2, ?, ?)
  FROM temp.search_evidence
  WHERE search_evidence MATCH ?
  ORDER BY rowid
 `, start, end, start, end, start, end, strings.Join(terms, " OR "))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var source video.VideoSourceID
		var id video.VideoID
		var title, description, publisher string
		if err := rows.Scan(&source, &id, &title, &description, &publisher); err != nil {
			return err
		}
		i := indices[id]
		results[i].Sources = append(results[i].Sources, search.SourceMatch{
			SourceID:    source,
			Title:       strings.Contains(title, start),
			Description: strings.Contains(description, start),
			Publisher:   strings.Contains(publisher, start),
		})
	}
	return rows.Err()
}

// searchMarkers avance déterministement jusqu'à une paire absente des données.
func searchMarkers(text string) (string, string) {
	for i := 0; ; i++ {
		prefix := "⟦sillage-search-" + strconv.Itoa(i)
		start, end := prefix+"-start⟧", prefix+"-end⟧"
		if !strings.Contains(text, start) && !strings.Contains(text, end) {
			return start, end
		}
	}
}

// searchSegments transforme les marqueurs internes en segments sûrs, sans échappement HTML.
func searchSegments(text, start, end string) []search.Segment {
	segments := []search.Segment{}
	highlighted := false
	for text != "" {
		marker := start
		if highlighted {
			marker = end
		}
		before, after, found := strings.Cut(text, marker)
		if before != "" {
			segments = append(segments, search.Segment{Text: before, Highlight: highlighted})
		}
		if !found {
			break
		}
		highlighted = !highlighted
		text = after
	}
	return segments
}

// limitSearchExcerpt borne aussi les tokens démesurés (chemins ou identifiants sans espaces).
// La fenêtre garde la première marque visible, sans promettre de montrer tous les termes.
func limitSearchExcerpt(segments []search.Segment) []search.Segment {
	const limit = 600
	const contextBefore = 120
	total, firstMatch := 0, -1
	for _, segment := range segments {
		if segment.Highlight && firstMatch < 0 {
			firstMatch = total
		}
		total += len([]rune(segment.Text))
	}
	if total <= limit {
		return segments
	}
	start := 0
	if firstMatch > contextBefore {
		start = firstMatch - contextBefore
	}
	end := min(total, start+limit)
	result := []search.Segment{}
	if start > 0 {
		result = append(result, search.Segment{Text: "…"})
	}
	offset := 0
	for _, segment := range segments {
		text := []rune(segment.Text)
		next := offset + len(text)
		from, to := max(start, offset), min(end, next)
		if from < to {
			result = append(result, search.Segment{Text: string(text[from-offset : to-offset]), Highlight: segment.Highlight})
		}
		offset = next
		if offset >= end {
			break
		}
	}
	if end < total {
		result = append(result, search.Segment{Text: "…"})
	}
	return result
}
