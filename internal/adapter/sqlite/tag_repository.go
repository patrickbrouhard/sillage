package sqlite

import (
	"context"
	"database/sql"
	"errors"

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

// Catalog lit les trois compteurs dans un même instantané, sans produit de jointures.
func (r *TagRepository) Catalog(ctx context.Context) ([]video.TagCatalogEntry, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			t.id,
			t.name,
			(SELECT COUNT(*) FROM video_tags WHERE tag_id = t.id),
			(SELECT COUNT(*) FROM publisher_tags WHERE tag_id = t.id),
			(SELECT COUNT(*) FROM person_tags WHERE tag_id = t.id)
		FROM tags t
		ORDER BY t.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]video.TagCatalogEntry, 0)
	for rows.Next() {
		var item video.TagCatalogEntry
		if err := rows.Scan(
			&item.ID,
			&item.Name,
			&item.VideoCount,
			&item.PublisherCount,
			&item.PersonCount,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// Rename conserve tous les liens et publie le nouveau texte FTS dans la transaction.
func (r *TagRepository) Rename(ctx context.Context, id video.TagID, name video.TagName) (video.Tag, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return video.Tag{}, err
	}
	defer tx.Rollback()
	var currentID video.TagID
	if err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM tags
		WHERE id = ?
	`, id).Scan(&currentID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return video.Tag{}, video.ErrTagNotFound
		}
		return video.Tag{}, err
	}
	// Le verrou immédiat sérialise cette vérification avec les autres écritures.
	var collision bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM tags
			WHERE identity_key = ? AND id <> ?
		)
	`, name.Key, id).Scan(&collision); err != nil {
		return video.Tag{}, err
	}
	if collision {
		return video.Tag{}, video.ErrTagConflict
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE tags
		SET name = ?, identity_key = ?
		WHERE id = ?
	`, name.Name, name.Key, id); err != nil {
		return video.Tag{}, err
	}
	ids, err := tagVideoIDs(ctx, tx, id)
	if err != nil {
		return video.Tag{}, err
	}
	for _, videoID := range ids {
		if err := rebuildSearchVideo(ctx, tx, videoID); err != nil {
			return video.Tag{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return video.Tag{}, err
	}
	return video.Tag{ID: id, Name: name.Name}, nil
}

// Delete retire les associations présentes au verrouillage, jamais les entités liées.
func (r *TagRepository) Delete(ctx context.Context, id video.TagID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Mémoriser les vidéos avant de retirer leurs liens ; aucun héritage n'est indexé.
	ids, err := tagVideoIDs(ctx, tx, id)
	if err != nil {
		return err
	}
	for _, table := range []string{"video_tags", "publisher_tags", "person_tags"} {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM `+table+`
			WHERE tag_id = ?
		`, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM tags
		WHERE id = ?
	`, id); err != nil {
		return err
	}
	for _, videoID := range ids {
		if err := rebuildSearchVideo(ctx, tx, videoID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// tagVideoIDs ferme la lecture avant toute reconstruction ou suppression de liens.
func tagVideoIDs(ctx context.Context, tx *sql.Tx, id video.TagID) ([]video.VideoID, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT video_id
		FROM video_tags
		WHERE tag_id = ?
		ORDER BY video_id ASC
	`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []video.VideoID
	for rows.Next() {
		var videoID video.VideoID
		if err := rows.Scan(&videoID); err != nil {
			return nil, err
		}
		ids = append(ids, videoID)
	}
	return ids, rows.Err()
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
	if err := rebuildSearchVideo(ctx, tx, id); err != nil {
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
	if err := rebuildSearchVideo(ctx, tx, id); err != nil {
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
