// Package media gère la conservation volontaire des représentations locales.
package media

import (
	"context"
	"errors"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// File représente un fichier complet publié ; OriginSourceID est facultatif hors téléchargement.
type File struct {
	ID             int64
	VideoID        video.VideoID
	OriginSourceID *video.VideoSourceID
	Path           string
	Format         string
	Size           int64
	DurationMS     int64
	AddedAt        time.Time
}

// State décrit la disponibilité durable et l'activité éphémère d'une source.
type State struct {
	Status    string
	File      *File
	ErrorCode string
}

var (
	ErrNotFound    = errors.New("media not found")
	ErrBusy        = errors.New("download busy")
	ErrUnavailable = errors.New("local media unavailable")
	ErrUnsupported = errors.New("source unsupported")
	ErrSelection   = errors.New("no compatible formats")
	ErrAudio       = errors.New("ambiguous audio")
	ErrUnfinished  = errors.New("video unfinished")
	ErrDuration    = errors.New("duration mismatch")
	ErrDownload    = errors.New("download failed")
	ErrInvalid     = errors.New("invalid downloaded media")
)

// Repository conserve uniquement les médias publiés.
type Repository interface {
	List(context.Context) ([]File, error)
	BySource(context.Context, video.VideoSourceID) (File, error)
	Get(context.Context, int64) (File, error)
	Save(context.Context, File) (File, error)
	Delete(context.Context, int64) error
}

// VideoReader vérifie l'appartenance de la source sans dépendre du transport.
type VideoReader interface {
	Get(context.Context, video.VideoID) (video.Video, error)
}

// Acquired décrit le fichier validé media.<Format> dans la zone temporaire.
type Acquired struct {
	Format     string
	Size       int64
	DurationMS int64
}

// Provider acquiert et valide sans publier ni modifier la base.
type Provider interface {
	Download(context.Context, video.VideoSource, string) (Acquired, error)
}

// Storage maîtrise les chemins, la publication et la récupération après interruption.
type Storage interface {
	Recover(context.Context, []File) error
	Prepare() (string, error)
	Discard(string) error
	Publish(context.Context, string, Acquired) (string, error)
	Check(File) error
	RemovePublished(string) error
	StageDelete(File) error
	Restore(File) error
	FinishDelete(File) error
}

// Code traduit les erreurs techniques en catégories publiques sans diagnostic sensible.
func Code(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "download_timeout"
	case errors.Is(err, context.Canceled):
		return "download_interrupted"
	case errors.Is(err, ErrSelection):
		return "media_format_unavailable"
	case errors.Is(err, ErrAudio):
		return "media_audio_ambiguous"
	case errors.Is(err, ErrUnfinished):
		return "media_unfinished"
	case errors.Is(err, ErrDuration):
		return "media_duration_mismatch"
	case errors.Is(err, ErrInvalid):
		return "media_invalid"
	case errors.Is(err, ErrDownload):
		return "download_failed"
	default:
		return "internal_error"
	}
}
