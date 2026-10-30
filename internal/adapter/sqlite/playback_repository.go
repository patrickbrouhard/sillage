package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/patrickbrouhard/sillage/internal/playback"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// PlaybackRepository conserve un seul point par source, indépendant du fichier local.
type PlaybackRepository struct{ db *sql.DB }

var _ playback.Repository = (*PlaybackRepository)(nil)

// NewPlaybackRepository utilise la base migrée sans en prendre la propriété.
func NewPlaybackRepository(db *sql.DB) *PlaybackRepository { return &PlaybackRepository{db: db} }

// Get distingue une source étrangère ou absente d'une progression absente.
func (r *PlaybackRepository) Get(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (*int64, error) {
	var position sql.NullInt64
	err := r.db.QueryRowContext(ctx, `
		SELECT
			p.position_ms
		FROM video_sources s
		LEFT JOIN playback_progress p
			ON p.video_source_id = s.id
		WHERE s.id = ? AND s.video_id = ?
	`, sourceID, videoID).Scan(&position)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, video.ErrVideoSourceNotFound
	}
	if err != nil {
		return nil, err
	}
	if !position.Valid {
		return nil, nil
	}
	return &position.Int64, nil
}

// Save sérialise la vérification d'appartenance et le remplacement, sans ordre interclients.
func (r *PlaybackRepository) Save(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID, position *int64) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var found int
	err = tx.QueryRowContext(ctx, `
		SELECT
			1
		FROM video_sources
		WHERE id = ? AND video_id = ?
	`, sourceID, videoID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return video.ErrVideoSourceNotFound
	}
	if err != nil {
		return err
	}
	if position == nil {
		_, err = tx.ExecContext(ctx, `
			DELETE FROM playback_progress
			WHERE video_source_id = ?
		`, sourceID)
	} else {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO playback_progress (video_source_id, position_ms)
			VALUES (?, ?)
			ON CONFLICT (video_source_id) DO UPDATE
			SET position_ms = excluded.position_ms
			WHERE playback_progress.position_ms != excluded.position_ms
		`, sourceID, *position)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
