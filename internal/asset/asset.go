// Package asset conserve les images indépendamment des notes et des médias.
package asset

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// Asset possède une identité durable avant même la production des octets.
type Asset struct {
	ID          int64
	VideoID     video.VideoID
	SourceID    *video.VideoSourceID
	TimestampMS *int64
	Type        string
	Status      string
	Path        *string
	Size        int64
	ErrorCode   string
	RequestID   string
	CreatedAt   time.Time
}

var (
	ErrNotFound        = errors.New("asset not found")
	ErrBusy            = errors.New("capture busy")
	ErrRequestConflict = errors.New("capture request reused")
	ErrUnavailable     = errors.New("asset content unavailable")
	ErrExtract         = errors.New("capture extraction failed")
)

// Repository conserve les intentions avant extraction.
type Repository interface {
	// List parcourt les captures d'une vidéo dans l'ordre temporel puis par identité.
	List(context.Context, video.VideoID, int, int) ([]Asset, error)
	// Get lit une identité stable.
	Get(context.Context, int64) (Asset, error)
	// ByRequest retrouve une commande sans relancer son travail.
	ByRequest(context.Context, string) (Asset, error)
	// Create insère une intention unique.
	Create(context.Context, Asset) (Asset, error)
	// Finish confirme une intention encore en attente.
	Finish(context.Context, int64, string, *string, int64, string) error
	// Interrupt termine les intentions abandonnées au redémarrage.
	Interrupt(context.Context) error
}

// Videos vérifie l'appartenance de la timeline.
type Videos interface {
	Get(context.Context, video.VideoID) (video.Video, error)
}

// LocalMedia réserve un fichier contre sa suppression pendant l'extraction.
type LocalMedia interface {
	Borrow(context.Context, video.VideoID, video.VideoSourceID) (string, func(), error)
}

// Extractor décode une image ; un chemin vide demande la source distante.
type Extractor interface {
	Extract(context.Context, video.VideoSource, string, int64, string) error
}

// Content permet une lecture seekable sans exposer le filesystem au cœur.
type Content interface {
	io.Reader
	io.Seeker
	io.Closer
}

// Storage réserve, valide et publie les PNG sans effacement compensatoire.
type Storage interface {
	Prepare() (string, error)
	Discard(string) error
	Publish(context.Context, string, Asset) (string, int64, error)
	Open(Asset) (Content, error)
}

// Page contient une portion bornée du catalogue, indépendante des références Markdown.
type Page struct {
	Assets  []Asset
	Number  int
	HasMore bool
}

// PageSize borne les métadonnées et les images proposées par consultation.
const PageSize = 12
