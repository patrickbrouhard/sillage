// Package video définit les objets de connaissance indépendamment de leurs sources.
package video

import "time"

// VideoID identifie une vidéo dans Sillage, indépendamment de sa provenance.
type VideoID int64

// VideoSourceID identifie une source dans Sillage, indépendamment de son identifiant externe.
type VideoSourceID int64

// Video regroupe les sources d'une vidéo de la base de connaissances.
type Video struct {
	ID        VideoID       `json:"id"`
	CreatedAt time.Time     `json:"created_at"`
	Sources   []VideoSource `json:"sources"`
}

// VideoSource contient la provenance et ses métadonnées.
// Une chaîne optionnelle vide représente une information absente.
type VideoSource struct {
	ID           VideoSourceID `json:"id"`
	VideoID      VideoID       `json:"video_id"`
	Provider     string        `json:"provider"`
	ExternalID   string        `json:"external_id,omitempty"`
	CanonicalURL string        `json:"canonical_url,omitempty"`
	Title        string        `json:"title"`
	Description  string        `json:"description,omitempty"`
	Creator      string        `json:"creator,omitempty"`
	// DurationMS vaut nil lorsque la durée est inconnue, notamment pour un direct.
	DurationMS   *int64 `json:"duration_ms,omitempty"`
	ThumbnailURL string `json:"thumbnail_url,omitempty"`
}
