package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// NoteRepository conserve une seule note par vidéo, sans transformation du contenu.
type NoteRepository struct{ db *sql.DB }

var _ note.Repository = (*NoteRepository)(nil)

// NewNoteRepository utilise la base migrée sans en prendre la propriété.
func NewNoteRepository(db *sql.DB) *NoteRepository { return &NoteRepository{db: db} }

// Get distingue la vidéo absente de la note absente dans une seule lecture.
func (r *NoteRepository) Get(ctx context.Context, id video.VideoID) (note.Note, error) {
	var content, created, updated sql.NullString
	var revision sql.NullInt64
	err := r.db.QueryRowContext(ctx, `
		SELECT
			n.content_md,
			n.created_at,
			n.updated_at,
			n.revision
		FROM videos v
		LEFT JOIN notes n
			ON n.video_id = v.id
		WHERE v.id = ?
	`, id).Scan(&content, &created, &updated, &revision)
	if errors.Is(err, sql.ErrNoRows) {
		return note.Note{}, video.ErrVideoNotFound
	}
	if err != nil {
		return note.Note{}, fmt.Errorf("read note: %w", err)
	}
	// Une chaîne vide est valide ; seul le NULL de la jointure signifie l'absence.
	if !content.Valid {
		return note.Note{}, note.ErrNotFound
	}
	return storedNote(id, content.String, created.String, updated.String, revision.Int64)
}

// Save sérialise lecture et écriture pour conserver les dates des sauvegardes identiques.
func (r *NoteRepository) Save(ctx context.Context, id video.VideoID, content string, expectedRevision int64, at time.Time) (note.SaveResult, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return note.SaveResult{}, err
	}
	defer tx.Rollback()
	if err := requireVideo(ctx, tx, id); err != nil {
		return note.SaveResult{}, err
	}
	var previous, created, updated string
	var revision int64
	err = tx.QueryRowContext(ctx, `
		SELECT
			content_md,
			created_at,
			updated_at,
			revision
		FROM notes
		WHERE video_id = ?
	`, id).Scan(&previous, &created, &updated, &revision)
	isNew := errors.Is(err, sql.ErrNoRows)
	if err != nil && !isNew {
		return note.SaveResult{}, err
	}
	// Le verrou immédiat couvre la comparaison, même lorsque la note est absente.
	// Vérifier avant le no-op évite d'accepter une ancienne précondition.
	if revision != expectedRevision {
		return note.SaveResult{}, note.ErrConflict
	}
	if isNew {
		revision = 1
		created, updated = formatDate(at), formatDate(at)
		_, err = tx.ExecContext(ctx, `
			INSERT INTO notes (video_id, content_md, created_at, updated_at, revision)
			VALUES (?, ?, ?, ?, ?)
		`, id, content, created, updated, revision)
	} else if previous != content {
		revision++
		updated = formatDate(at)
		_, err = tx.ExecContext(ctx, `
			UPDATE notes
			SET
				content_md = ?,
				updated_at = ?,
				revision = ?
			WHERE video_id = ?
		`, content, updated, revision, id)
	}
	if err != nil {
		return note.SaveResult{}, err
	}
	if isNew || previous != content {
		if err := rebuildSearchVideo(ctx, tx, id); err != nil {
			return note.SaveResult{}, err
		}
	}
	saved, err := storedNote(id, content, created, updated, revision)
	if err != nil {
		return note.SaveResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return note.SaveResult{}, err
	}
	return note.SaveResult{Note: saved, Created: isNew}, nil
}

func storedNote(id video.VideoID, content, created, updated string, revision int64) (note.Note, error) {
	createdAt, err := parseDate(created)
	if err != nil {
		return note.Note{}, err
	}
	updatedAt, err := parseDate(updated)
	if err != nil {
		return note.Note{}, err
	}
	return note.Note{VideoID: id, Revision: revision, ContentMD: content, CreatedAt: createdAt, UpdatedAt: updatedAt}, nil
}

// requireVideo vérifie le parent sous le verrou de la transaction d'écriture.
func requireVideo(ctx context.Context, tx *sql.Tx, id video.VideoID) error {
	var found int
	err := tx.QueryRowContext(ctx, "SELECT 1 FROM videos WHERE id = ?", id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return video.ErrVideoNotFound
	}
	return err
}
