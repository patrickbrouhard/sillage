package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// MediaRepository conserve les fichiers complets indépendamment des opérations.
type MediaRepository struct{ db *sql.DB }

// NewMediaRepository utilise la base migrée sans en prendre la propriété.
func NewMediaRepository(db *sql.DB) *MediaRepository { return &MediaRepository{db: db} }

const mediaColumns = `
 id,
 video_id,
 origin_source_id,
 path,
 format,
 size,
 duration_ms,
 added_at
`

func scanMedia(row interface{ Scan(...any) error }) (media.File, error) {
	var f media.File
	var source sql.NullInt64
	var added string
	err := row.Scan(&f.ID, &f.VideoID, &source, &f.Path, &f.Format, &f.Size, &f.DurationMS, &added)
	if errors.Is(err, sql.ErrNoRows) {
		return f, media.ErrNotFound
	}
	if err != nil {
		return f, err
	}
	if source.Valid {
		id := video.VideoSourceID(source.Int64)
		f.OriginSourceID = &id
	}
	f.AddedAt, err = parseDate(added)
	return f, err
}

// List permet le rapprochement du stockage avant le démarrage des acquisitions.
func (r *MediaRepository) List(ctx context.Context) ([]media.File, error) {
	rows, err := r.db.QueryContext(ctx, `
 SELECT `+mediaColumns+`
 FROM media_files
 ORDER BY id
 `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files := []media.File{}
	for rows.Next() {
		f, err := scanMedia(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// Get retrouve une identité de fichier pour une suppression ciblée.
func (r *MediaRepository) Get(ctx context.Context, id int64) (media.File, error) {
	return scanMedia(r.db.QueryRowContext(ctx, `
 SELECT `+mediaColumns+`
 FROM media_files
 WHERE id = ?
 `, id))
}

// BySource retrouve le fichier conservé sans le remplacer.
func (r *MediaRepository) BySource(ctx context.Context, id video.VideoSourceID) (media.File, error) {
	return scanMedia(r.db.QueryRowContext(ctx, `
 SELECT `+mediaColumns+`
 FROM media_files
 WHERE origin_source_id = ?
 `, id))
}

// Save insère le média ; les contraintes protègent provenance et unicité en concurrence.
func (r *MediaRepository) Save(ctx context.Context, f media.File) (media.File, error) {
	err := r.db.QueryRowContext(ctx, `
 INSERT INTO media_files (
  video_id,
  origin_source_id,
  path,
  format,
  size,
  duration_ms,
  added_at
 )
 VALUES (?, ?, ?, ?, ?, ?, ?)
 RETURNING id
 `, f.VideoID, f.OriginSourceID, f.Path, f.Format, f.Size, f.DurationMS, formatDate(f.AddedAt)).Scan(&f.ID)
	return f, err
}

// Delete ne touche qu'à la ligne du média, jamais à ses propriétaires.
func (r *MediaRepository) Delete(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `
 DELETE FROM media_files
 WHERE id = ?
 `, id)
	return err
}
