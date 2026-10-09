// Package http assemble les routes de l'API REST.
package http

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/http/handlers"
)

// NewRouter expose vidéos, notes, tags et transcriptions sous le préfixe versionné.
func NewRouter(
	notes handlers.NoteService,
	tags handlers.TagService,
	transcripts handlers.TranscriptService,
	service handlers.VideoService,
	postTimeout time.Duration,
) http.Handler {
	r := chi.NewRouter()
	h := handlers.NewVideoHandler(service, postTimeout)
	t := handlers.NewTranscriptHandler(transcripts, postTimeout)
	k := handlers.NewKnowledgeHandler(notes, tags)
	r.Get("/api/v1/tags", k.ListTags)
	r.Route("/api/v1/videos", func(r chi.Router) {
		r.Post("/", h.Add)
		r.Get("/", h.List)
		r.Get("/{id}", h.Get)
		r.Get("/{id}/note", k.GetNote)
		r.Put("/{id}/note", k.PutNote)
		r.Post("/{id}/tags", k.AddTags)
		r.Delete("/{id}/tags/{tag_id}", k.RemoveTag)
		r.Post("/{video_id}/sources/{source_id}/transcript", t.Fetch)
		r.Get("/{video_id}/sources/{source_id}/transcript", t.Get)
	})
	return r
}
