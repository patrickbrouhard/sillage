package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
	driver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// VideoRepository implémente le port de persistance sur une base ouverte par Open.
type VideoRepository struct {
	db *sql.DB
}

var _ video.VideoRepository = (*VideoRepository)(nil)

// NewVideoRepository utilise la base migrée fournie sans en prendre la propriété.
func NewVideoRepository(db *sql.DB) *VideoRepository {
	return &VideoRepository{db: db}
}

// Create crée atomiquement une nouvelle vidéo et toutes ses sources.
// Les identités sont attribuées par SQLite ; l'argument n'est pas modifié.
func (r *VideoRepository) Create(ctx context.Context, v video.Video) (video.Video, error) {
	if v.ID != 0 || v.CreatedAt.IsZero() || len(v.Sources) == 0 {
		return video.Video{}, fmt.Errorf("create requires a new, dated video with sources")
	}
	for _, source := range v.Sources {
		if source.ID != 0 || source.VideoID != 0 ||
			strings.TrimSpace(source.Provider) == "" || strings.TrimSpace(source.Title) == "" {
			return video.Video{}, fmt.Errorf("create requires new sources with provider and title")
		}
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return video.Video{}, fmt.Errorf("begin video creation: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, "INSERT INTO videos (created_at_ms) VALUES (?)", v.CreatedAt.UnixMilli())
	if err != nil {
		return video.Video{}, fmt.Errorf("insert video: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return video.Video{}, fmt.Errorf("read video ID: %w", err)
	}
	created := video.Video{
		ID:        video.VideoID(id),
		CreatedAt: time.UnixMilli(v.CreatedAt.UnixMilli()).UTC(),
		Sources:   make([]video.VideoSource, 0, len(v.Sources)),
	}
	for _, source := range v.Sources {
		result, err := tx.ExecContext(ctx, `INSERT INTO video_sources
			(video_id, provider, external_id, canonical_url, title, description, creator, duration_ms, thumbnail_url)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, source.Provider, nullableText(source.ExternalID), nullableText(source.CanonicalURL),
			source.Title, nullableText(source.Description), nullableText(source.Creator),
			source.DurationMS, nullableText(source.ThumbnailURL))
		if err != nil {
			var sqliteErr *driver.Error
			// Cet INSERT ne fournit aucun ID ; son seul conflit UNIQUE possible
			// dans le schéma actuel est l'identité externe de la source.
			if errors.As(err, &sqliteErr) && sqliteErr.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE {
				return video.Video{}, fmt.Errorf("insert video source: %w", video.ErrSourceAlreadyExists)
			}
			return video.Video{}, fmt.Errorf("insert video source: %w", err)
		}
		sourceID, err := result.LastInsertId()
		if err != nil {
			return video.Video{}, fmt.Errorf("read source ID: %w", err)
		}
		source.ID = video.VideoSourceID(sourceID)
		source.VideoID = created.ID
		created.Sources = append(created.Sources, source)
	}
	if err := tx.Commit(); err != nil {
		return video.Video{}, fmt.Errorf("commit video creation: %w", err)
	}
	return created, nil
}

// Get relit une vidéo avec toutes ses sources, ordonnées par identité interne.
func (r *VideoRepository) Get(ctx context.Context, id video.VideoID) (video.Video, error) {
	return r.read(ctx, "v.id = ?", id)
}

// FindBySource retrouve la vidéo entière via une identité externe renseignée.
func (r *VideoRepository) FindBySource(ctx context.Context, provider, externalID string) (video.Video, error) {
	if externalID == "" {
		return video.Video{}, video.ErrVideoNotFound
	}
	return r.read(ctx, `v.id = (SELECT video_id FROM video_sources WHERE provider = ? AND external_id = ?)`,
		provider, externalID)
}

// List charge la bibliothèque et ses sources en une seule requête.
func (r *VideoRepository) List(ctx context.Context) ([]video.Video, error) {
	return r.query(ctx, "1 = 1")
}

// read retrouve un agrégat avec le même décodage que la bibliothèque.
func (r *VideoRepository) read(ctx context.Context, predicate string, args ...any) (video.Video, error) {
	videos, err := r.query(ctx, predicate, args...)
	if err != nil {
		return video.Video{}, err
	}
	if len(videos) == 0 {
		return video.Video{}, video.ErrVideoNotFound
	}
	return videos[0], nil
}

// query regroupe les lignes jointes dans l'ordre du contrat de bibliothèque.
// predicate est exclusivement fourni par les méthodes du repository.
func (r *VideoRepository) query(ctx context.Context, predicate string, args ...any) ([]video.Video, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			v.id,
			v.created_at_ms,
			s.id,
			s.provider,
			s.external_id,
			s.canonical_url,
			s.title,
			s.description,
			s.creator,
			s.duration_ms,
			s.thumbnail_url
		FROM videos v
		LEFT JOIN video_sources s
			ON s.video_id = v.id
		WHERE `+predicate+`
		ORDER BY
			v.created_at_ms DESC,
			v.id DESC,
			s.id ASC
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("query videos: %w", err)
	}
	defer rows.Close()

	videos := make([]video.Video, 0)

	// Une vidéo peut apparaître sur plusieurs lignes, une par source jointe.
	for rows.Next() {
		var id video.VideoID
		var createdAtMS int64
		var sourceID, duration sql.NullInt64
		var provider, externalID, canonicalURL, title, description, creator, thumbnail sql.NullString

		if err := rows.Scan(
			&id,
			&createdAtMS,
			&sourceID,
			&provider,
			&externalID,
			&canonicalURL,
			&title,
			&description,
			&creator,
			&duration,
			&thumbnail,
		); err != nil {
			return nil, fmt.Errorf("scan video: %w", err)
		}

		// L'ordre SQL garantit que toutes les sources d'une vidéo sont contiguës.
		if len(videos) == 0 || videos[len(videos)-1].ID != id {
			videos = append(videos, video.Video{
				ID:        id,
				CreatedAt: time.UnixMilli(createdAtMS).UTC(),
				Sources:   make([]video.VideoSource, 0),
			})
		}

		// Le LEFT JOIN peut produire une ligne sans source associée.
		if sourceID.Valid {
			source := video.VideoSource{
				ID:           video.VideoSourceID(sourceID.Int64),
				VideoID:      id,
				Provider:     provider.String,
				ExternalID:   externalID.String,
				CanonicalURL: canonicalURL.String,
				Title:        title.String,
				Description:  description.String,
				Creator:      creator.String,
				ThumbnailURL: thumbnail.String,
			}

			// La durée est optionnelle en base.
			if duration.Valid {
				source.DurationMS = &duration.Int64
			}

			v := &videos[len(videos)-1]
			v.Sources = append(v.Sources, source)
		}
	}

	// rows.Err couvre les erreurs survenues pendant l'itération.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read video rows: %w", err)
	}

	return videos, nil
}

// nullableText traduit la convention métier « chaîne vide = absente » en NULL.
func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}
