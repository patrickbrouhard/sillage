// Package http assemble les routes de l'API REST.
package http

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/http/handlers"
)

// NewRouter expose les vidéos et les transcriptions de leurs sources sous le préfixe versionné.
func NewRouter(transcripts handlers.TranscriptService, service handlers.VideoService, postTimeout time.Duration) http.Handler {
	r := chi.NewRouter()
	h := handlers.NewVideoHandler(service, postTimeout)
	t := handlers.NewTranscriptHandler(transcripts, postTimeout)
	r.Route("/api/v1/videos", func(r chi.Router) {
		r.Post("/", h.Add)
		r.Get("/", h.List)
		r.Get("/{id}", h.Get)
		r.Post("/{video_id}/sources/{source_id}/transcript", t.Fetch)
		r.Get("/{video_id}/sources/{source_id}/transcript", t.Get)
	})
	return r
}
