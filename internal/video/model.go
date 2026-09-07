// Package video définit les objets de connaissance indépendamment de leurs sources.
package video

// Video regroupe les sources d'une vidéo de la base de connaissances.
// À cette étape d'extraction, elle n'est pas persistée et n'a pas encore d'identité interne.
type Video struct {
	Sources []VideoSource `json:"sources"`
}

// VideoSource contient uniquement les métadonnées utiles d'une origine externe.
type VideoSource struct {
	Provider    string `json:"provider"`
	ExternalID  string `json:"external_id"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Creator     string `json:"creator,omitempty"`
	// DurationMS vaut nil lorsque la durée est inconnue, notamment pour un direct.
	DurationMS   *int64 `json:"duration_ms,omitempty"`
	ThumbnailURL string `json:"thumbnail_url,omitempty"`
}
