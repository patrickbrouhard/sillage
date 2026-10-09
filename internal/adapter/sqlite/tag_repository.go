package sqlite

import (
	"context"
	"database/sql"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// TagRepository persiste les tags partagés et leurs associations atomiques.
type TagRepository struct{ db *sql.DB }

var _ video.TagRepository = (*TagRepository)(nil)

// NewTagRepository utilise la base migrée sans en prendre la propriété.
func NewTagRepository(db *sql.DB) *TagRepository { return &TagRepository{db: db} }

// List retourne le catalogue entier par identifiant croissant.
func (r *TagRepository) List(ctx context.Context) ([]video.Tag, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			id,
			name
		FROM tags
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, err
	}
	return readTags(rows)
}

// Add conserve l'affichage existant et annule aussi les créations en cas d'échec.
func (r *TagRepository) Add(ctx context.Context, id video.VideoID, names []video.TagName) ([]video.Tag, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := requireVideo(ctx, tx, id); err != nil {
		return nil, err
	}
	for _, name := range names {
		// La clé unique protège les appels concurrents ; aucun renommage implicite.
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO tags (name, identity_key)
			VALUES (?, ?)
			ON CONFLICT (identity_key) DO NOTHING
		`, name.Name, name.Key); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO video_tags (video_id, tag_id)
			SELECT
				?,
				id
			FROM tags
			WHERE identity_key = ?
			ON CONFLICT (video_id, tag_id) DO NOTHING
		`, id, name.Key); err != nil {
			return nil, err
		}
	}
	// Lire avant le commit restitue le résultat complet de cette opération atomique.
	rows, err := tx.QueryContext(ctx, `
		SELECT
			t.id,
			t.name
		FROM tags t
		JOIN video_tags vt
			ON vt.tag_id = t.id
		WHERE vt.video_id = ?
		ORDER BY t.id ASC
	`, id)
	if err != nil {
		return nil, err
	}
	tags, err := readTags(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return tags, nil
}

// Remove ne supprime jamais le tag partagé, même après sa dernière association.
func (r *TagRepository) Remove(ctx context.Context, id video.VideoID, tagID video.TagID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requireVideo(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM video_tags
		WHERE video_id = ? AND tag_id = ?
	`, id, tagID); err != nil {
		return err
	}
	return tx.Commit()
}

// readTags ferme les lignes avant tout commit et conserve les résultats vides non nil.
func readTags(rows *sql.Rows) ([]video.Tag, error) {
	defer rows.Close()
	tags := make([]video.Tag, 0)
	for rows.Next() {
		var tag video.Tag
		if err := rows.Scan(&tag.ID, &tag.Name); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}
