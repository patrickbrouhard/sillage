package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/patrickbrouhard/sillage/internal/deletion"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// DeletionRepository conserve la preuve d'autorisation jusqu'à la fin des effacements.
type DeletionRepository struct{ db *sql.DB }

// NewDeletionRepository utilise la connexion migrée partagée.
func NewDeletionRepository(db *sql.DB) *DeletionRepository { return &DeletionRepository{db: db} }

// Delete regroupe inventaire, manifeste, connaissances et FTS dans une transaction immédiate.
func (r *DeletionRepository) Delete(ctx context.Context, id video.VideoID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requireVideo(ctx, tx, id); errors.Is(err, video.ErrVideoNotFound) {
		return tx.Commit()
	} else if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
  INSERT INTO video_purges (video_id) VALUES (?)
 `, id); err != nil {
		return err
	}
	// Tous les états et toutes les sources comptent, y compris les médias sans provenance.
	if _, err := tx.ExecContext(ctx, `
  INSERT INTO video_purge_files (video_id, kind, path)
  SELECT
   video_id,
   'media',
   path
  FROM media_files
  WHERE video_id = ?
  UNION
  SELECT
   video_id,
   'asset',
   path
  FROM assets
  WHERE video_id = ? AND path IS NOT NULL
  UNION
  SELECT
   s.video_id,
   'transcript',
   t.local_path
  FROM transcripts t
  JOIN video_sources s
   ON s.id = t.video_source_id
  WHERE s.video_id = ? AND t.local_path IS NOT NULL
 `, id, id, id); err != nil {
		return err
	}
	// Les enfants des sources disparaissent avant les sources, sans cascade implicite.
	for _, statement := range []string{
		`DELETE FROM playback_progress WHERE video_source_id IN (SELECT id FROM video_sources WHERE video_id = ?)`,
		`DELETE FROM transcripts WHERE video_source_id IN (SELECT id FROM video_sources WHERE video_id = ?)`,
		`DELETE FROM assets WHERE video_id = ?`,
		`DELETE FROM media_files WHERE video_id = ?`,
		`DELETE FROM notes WHERE video_id = ?`,
		`DELETE FROM video_tags WHERE video_id = ?`,
		`DELETE FROM video_persons WHERE video_id = ?`,
		`DELETE FROM video_sources WHERE video_id = ?`,
		`DELETE FROM video_search WHERE rowid = ?`,
		`DELETE FROM videos WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, statement, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Pending lit le marqueur et ses fichiers ensemble, même si le manifeste est vide.
func (r *DeletionRepository) Pending(ctx context.Context, id video.VideoID) ([]deletion.File, bool, error) {
	rows, err := r.db.QueryContext(ctx, `
  SELECT
   f.kind,
   f.path
  FROM video_purges p
  LEFT JOIN video_purge_files f
   ON f.video_id = p.video_id
  WHERE p.video_id = ?
  ORDER BY
   f.kind,
   f.path
 `, id)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var files []deletion.File
	exists := false
	for rows.Next() {
		exists = true
		var kind, path sql.NullString
		if err := rows.Scan(&kind, &path); err != nil {
			return nil, false, err
		}
		if kind.Valid {
			files = append(files, deletion.File{Kind: kind.String, Path: path.String})
		}
	}
	return files, exists, rows.Err()
}

// Complete retire atomiquement le manifeste ; une erreur laisse la reprise possible.
func (r *DeletionRepository) Complete(ctx context.Context, id video.VideoID) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM video_purge_files WHERE video_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM video_purges WHERE video_id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// List ne fournit que les manifestes autorisés, sans inspection du filesystem.
func (r *DeletionRepository) List(ctx context.Context) ([]video.VideoID, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT video_id FROM video_purges ORDER BY video_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []video.VideoID
	for rows.Next() {
		var id video.VideoID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
