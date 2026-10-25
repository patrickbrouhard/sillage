package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// AssetRepository conserve aussi les intentions et les échecs.
type AssetRepository struct{ db *sql.DB }

// NewAssetRepository utilise la connexion migrée partagée.
func NewAssetRepository(db *sql.DB) *AssetRepository { return &AssetRepository{db: db} }

const assetColumns = `
 id,
 video_id,
 source_id,
 timestamp_ms,
 type,
 status,
 path,
 size,
 error_code,
 request_id,
 created_at
`

func scanAsset(row interface{ Scan(...any) error }) (asset.Asset, error) {
	var a asset.Asset
	var created string
	err := row.Scan(
		&a.ID,
		&a.VideoID,
		&a.SourceID,
		&a.TimestampMS,
		&a.Type,
		&a.Status,
		&a.Path,
		&a.Size,
		&a.ErrorCode,
		&a.RequestID,
		&created,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return a, asset.ErrNotFound
	}
	if err != nil {
		return a, err
	}
	a.CreatedAt, err = parseDate(created)
	return a, err
}

// Get lit l'identité sans tester le disque.
func (r *AssetRepository) Get(ctx context.Context, id int64) (asset.Asset, error) {
	return scanAsset(r.db.QueryRowContext(ctx, `
 SELECT `+assetColumns+`
 FROM assets
 WHERE id = ?
 `, id))
}

// ByRequest retrouve une commande persistante même après redémarrage.
func (r *AssetRepository) ByRequest(ctx context.Context, key string) (asset.Asset, error) {
	return scanAsset(r.db.QueryRowContext(ctx, `
 SELECT `+assetColumns+`
 FROM assets
 WHERE request_id = ?
 `, key))
}

// Create ne remplace jamais une intention existante.
func (r *AssetRepository) Create(ctx context.Context, a asset.Asset) (asset.Asset, error) {
	err := r.db.QueryRowContext(ctx, `
 INSERT INTO assets (
  video_id,
  source_id,
  timestamp_ms,
  type,
  status,
  request_id,
  created_at
 )
 VALUES (?, ?, ?, ?, 'pending', ?, ?)
 RETURNING id
 `, a.VideoID, a.SourceID, a.TimestampMS, a.Type, a.RequestID, formatDate(a.CreatedAt)).Scan(&a.ID)
	return a, err
}

// Finish ne réécrit pas un résultat terminal après un commit incertain.
func (r *AssetRepository) Finish(ctx context.Context, id int64, status string, path *string, size int64, code string) error {
	_, err := r.db.ExecContext(ctx, `
 UPDATE assets
 SET status = ?,
     path = ?,
     size = ?,
     error_code = ?
 WHERE id = ?
   AND status = 'pending'
 `, status, path, size, code, id)
	return err
}

// Interrupt conserve intentions et fichiers ; aucune reprise implicite.
func (r *AssetRepository) Interrupt(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `
 UPDATE assets
 SET status = 'failed',
     error_code = 'capture_interrupted'
 WHERE status = 'pending'
 `)
	return err
}

// List conserve toutes les sources et états ; l'identité départage les temps égaux.
func (r *AssetRepository) List(ctx context.Context, videoID video.VideoID, offset, limit int) ([]asset.Asset, error) {
	rows, err := r.db.QueryContext(ctx, `
 SELECT `+assetColumns+`
 FROM assets
 WHERE video_id = ?
 ORDER BY
  timestamp_ms ASC,
  id ASC
 LIMIT ? OFFSET ?
 `, videoID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]asset.Asset, 0)
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}
