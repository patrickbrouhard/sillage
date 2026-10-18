// Package media gère la conservation volontaire des représentations locales.
package media

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// File représente un fichier complet publié ; OriginSourceID est facultatif hors téléchargement.
// Les caractéristiques nullable préservent les fichiers antérieurs à leur mesure.
// FPS est une moyenne ; AudioLanguage décrit la piste conservée, pas l'original de la source.
type File struct {
	ID             int64
	VideoID        video.VideoID
	OriginSourceID *video.VideoSourceID
	Path           string
	Format         string
	Size           int64
	DurationMS     int64
	AddedAt        time.Time
	VideoCodec     *string
	AudioCodec     *string
	Width          *int
	Height         *int
	FPS            *float64
	AudioLanguage  *string
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
	ErrUnfinished  = errors.New("video unfinished")
	ErrDuration    = errors.New("duration mismatch")
	ErrDownload    = errors.New("download failed")
	ErrInvalid     = errors.New("invalid downloaded media")
)

// Repository conserve uniquement les médias publiés.
type Repository interface {
	// List fournit les références durables avant le rapprochement du stockage.
	List(context.Context) ([]File, error)
	// BySource retourne le fichier unique ou ErrNotFound.
	BySource(context.Context, video.VideoSourceID) (File, error)
	// Get retrouve une identité exacte ou ErrNotFound.
	Get(context.Context, int64) (File, error)
	// Save insère sans remplacement et garantit provenance et unicité.
	Save(context.Context, File) (File, error)
	// Delete retire uniquement la référence du média.
	Delete(context.Context, int64) error
}

// VideoReader vérifie l'appartenance de la source sans dépendre du transport.
type VideoReader interface {
	// Get fournit les sources de la vidéo propriétaire.
	Get(context.Context, video.VideoID) (video.Video, error)
}

// Acquired décrit le fichier validé media.<Format> dans la zone temporaire.
type Acquired struct {
	Format        string
	Size          int64
	DurationMS    int64
	VideoCodec    *string
	AudioCodec    *string
	Width         *int
	Height        *int
	FPS           *float64
	AudioLanguage *string
}

// Provider acquiert et valide sans publier ni modifier la base.
type Provider interface {
	// Download écrit un fichier validé dans la zone réservée, sans le publier.
	Download(context.Context, video.VideoSource, string) (Acquired, error)
}

// Storage maîtrise les chemins, la publication et la récupération après interruption.
type Storage interface {
	// Recover restaure seulement les suppressions sûres et signale les anomalies sans effacer.
	Recover(context.Context, []File) error
	// Prepare réserve une zone temporaire sur le filesystem final.
	Prepare() (string, error)
	// Discard nettoie exclusivement la zone réservée.
	Discard(string) error
	// Publish synchronise puis expose un fichier complet sous un nom unique.
	Publish(context.Context, string, Acquired) (string, error)
	// Check vérifie présence, lisibilité et taille sans accès distant.
	Check(File) error
	// StageDelete déplace le fichier pour permettre une restauration après échec SQL.
	StageDelete(File) error
	// Restore restaure les octets si leur référence existe toujours.
	Restore(File) error
	// FinishDelete termine l’effacement après suppression de la référence.
	FinishDelete(File) error
}

// Code traduit les erreurs techniques en catégories publiques sans diagnostic sensible.
func Code(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "download_timeout"
	case errors.Is(err, context.Canceled):
		return "download_interrupted"
	case errors.Is(err, ErrUnsupported):
		return "media_source_unsupported"
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

// Content est un contenu seekable dont la fermeture libère aussi sa réservation.
type Content interface {
	io.Reader
	io.Seeker
	io.Closer
}
