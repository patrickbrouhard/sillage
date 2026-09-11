// Package video définit les objets de connaissance indépendamment de leurs sources.
package video

import "time"

// VideoID identifie une vidéo dans Sillage, indépendamment de sa provenance.
type VideoID int64

// VideoSourceID identifie une source dans Sillage, indépendamment de son identifiant externe.
type VideoSourceID int64

// Video regroupe les sources d'une vidéo de la base de connaissances.
type Video struct {
	ID        VideoID
	CreatedAt time.Time
	Sources   []VideoSource
}

// VideoSource contient la provenance et ses métadonnées.
// Une chaîne optionnelle vide représente une information absente.
type VideoSource struct {
	ID           VideoSourceID
	VideoID      VideoID
	Provider     string
	ExternalID   string
	CanonicalURL string
	Title        string
	Description  string
	Creator      string
	// DurationMS vaut nil lorsque la durée est inconnue, notamment pour un direct.
	DurationMS   *int64
	ThumbnailURL string
}
