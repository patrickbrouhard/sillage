package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// TranscriptRepository conserve les acquisitions sans stocker leurs fragments.
type TranscriptRepository struct{ db *sql.DB }

var _ transcript.Repository = (*TranscriptRepository)(nil)

// NewTranscriptRepository utilise la base migrée sans en prendre la propriété.
func NewTranscriptRepository(db *sql.DB) *TranscriptRepository {
	return &TranscriptRepository{db: db}
}

// Save conserve l'ID lors d'un rafraîchissement et renseigne la langue audio si absente.
// La transaction reste courte : le fichier a déjà été publié avant cet appel.
func (r *TranscriptRepository) Save(ctx context.Context, t transcript.Transcript) (transcript.Transcript, error) {
	if t.VideoSourceID <= 0 || strings.TrimSpace(t.Language) == "" || strings.TrimSpace(t.Provenance) == "" || t.LastFetchedAt.IsZero() {
		return transcript.Transcript{}, fmt.Errorf("transcript requires source, language, provenance and date")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return transcript.Transcript{}, err
	}
	defer tx.Rollback()
	if t.Provenance == transcript.YouTubeAuto {
		var language sql.NullString
		err := tx.QueryRowContext(ctx, `
   SELECT original_audio_language
   FROM video_sources
   WHERE id = ?
  `, t.VideoSourceID).Scan(&language)
		if errors.Is(err, sql.ErrNoRows) {
			return transcript.Transcript{}, video.ErrVideoSourceNotFound
		}
		if err != nil {
			return transcript.Transcript{}, err
		}
		// Une acquisition concurrente a pu renseigner la langue depuis la lecture du service.
		if language.Valid && language.String != t.Language {
			return transcript.Transcript{}, transcript.ErrNotAvailable
		}
		if !language.Valid {
			if _, err := tx.ExecContext(ctx, `
    UPDATE video_sources
    SET original_audio_language = ?
    WHERE id = ?
   `, t.Language, t.VideoSourceID); err != nil {
				return transcript.Transcript{}, err
			}
		}
	}
	err = tx.QueryRowContext(ctx, `
  INSERT INTO transcripts (
   video_source_id,
   language,
   provenance,
   local_path,
   last_fetched_at
  )
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (video_source_id, language, provenance)
  DO UPDATE SET
   local_path = excluded.local_path,
   last_fetched_at = excluded.last_fetched_at
  RETURNING id
 `, t.VideoSourceID, t.Language, t.Provenance, nullableText(t.LocalPath), formatDate(t.LastFetchedAt)).Scan(&t.ID)
	if err != nil {
		return transcript.Transcript{}, fmt.Errorf("save transcript row: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return transcript.Transcript{}, err
	}
	t.LastFetchedAt = t.LastFetchedAt.UTC().Truncate(time.Millisecond)
	return t, nil
}

// Latest sélectionne la politique actuelle par date puis ID décroissants, sans accès aux fichiers.
func (r *TranscriptRepository) Latest(ctx context.Context, sourceID video.VideoSourceID) (transcript.Transcript, error) {
	var t transcript.Transcript
	var path sql.NullString
	var date string
	err := r.db.QueryRowContext(ctx, `
  SELECT
   id,
   video_source_id,
   language,
   provenance,
   local_path,
   last_fetched_at
  FROM transcripts
  WHERE video_source_id = ? AND provenance = ?
  ORDER BY
   last_fetched_at DESC,
   id DESC
  LIMIT 1
 `, sourceID, transcript.YouTubeAuto).Scan(
		&t.ID,
		&t.VideoSourceID,
		&t.Language,
		&t.Provenance,
		&path,
		&date,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return transcript.Transcript{}, transcript.ErrNotFound
	}
	if err != nil {
		return transcript.Transcript{}, err
	}
	t.LocalPath = path.String
	t.LastFetchedAt, err = parseDate(date)
	if err != nil {
		return transcript.Transcript{}, fmt.Errorf("read transcript date: %w", err)
	}
	return t, nil
}
