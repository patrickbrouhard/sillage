package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/video"
)

const searchProjectionVersion = 2

// initializeSearch relit le marqueur sous verrou ; un échec ne publie aucun index partiel.
func initializeSearch(ctx context.Context, db *sql.DB, force bool) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	err = tx.QueryRowContext(ctx, "SELECT version FROM search_projection WHERE id = 1").Scan(&version)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if version == searchProjectionVersion && !force {
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM video_search"); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id FROM videos ORDER BY id")
	if err != nil {
		return err
	}
	var ids []video.VideoID
	for rows.Next() {
		var id video.VideoID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := rebuildSearchVideo(ctx, tx, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
  INSERT INTO search_projection (id, version)
  VALUES (1, ?)
  ON CONFLICT (id) DO UPDATE SET version = excluded.version
 `, searchProjectionVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// RebuildSearch régénère la projection depuis les données originales, y compris le Markdown.
// La transaction immédiate sérialise maintenance, initialisation et écritures métier.
func RebuildSearch(ctx context.Context, db *sql.DB) error {
	return initializeSearch(ctx, db, true)
}

// rebuildSearchVideo centralise la projection dans la transaction de l'écriture acceptée.
func rebuildSearchVideo(ctx context.Context, tx *sql.Tx, id video.VideoID) error {
	rows, err := tx.QueryContext(ctx, `
  SELECT
   s.title,
   COALESCE(s.description, ''),
   COALESCE(p.name, '')
  FROM video_sources s
  LEFT JOIN publishers p
   ON p.id = s.publisher_id
  WHERE s.video_id = ?
  ORDER BY s.id
 `, id)
	if err != nil {
		return err
	}
	var titles, descriptions, publishers []string
	for rows.Next() {
		var title, description, publisher string
		if err := rows.Scan(&title, &description, &publisher); err != nil {
			rows.Close()
			return err
		}
		titles = append(titles, title)
		descriptions = append(descriptions, description)
		publishers = append(publishers, publisher)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// Les tags directs sont agrégés séparément : aucun produit sources × tags.
	rows, err = tx.QueryContext(ctx, `
  SELECT
   t.name
  FROM video_tags vt
  JOIN tags t
   ON t.id = vt.tag_id
  WHERE vt.video_id = ?
  ORDER BY t.id
 `, id)
	if err != nil {
		return err
	}
	var tags []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			rows.Close()
			return err
		}
		tags = append(tags, tag)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var markdown string
	err = tx.QueryRowContext(ctx, "SELECT content_md FROM notes WHERE video_id = ?", id).Scan(&markdown)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM video_search WHERE rowid = ?", id); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
  INSERT INTO video_search (rowid, titles, tags, note, publishers, descriptions)
  VALUES (?, ?, ?, ?, ?, ?)
 `, id, uniqueSearchText(titles), uniqueSearchText(tags), markdownSearchText(markdown), uniqueSearchText(publishers), uniqueSearchText(descriptions))
	return err
}

// uniqueSearchText conserve le premier ordre et seulement les doublons strictement identiques.
func uniqueSearchText(values []string) string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return strings.Join(result, "\n\n")
}
