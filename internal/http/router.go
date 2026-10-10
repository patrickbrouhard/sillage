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
	publishers handlers.PublisherService,
	persons handlers.PersonService,
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
	p := handlers.NewPeopleHandler(publishers, persons, postTimeout)
	r.Route("/api/v1/publishers", func(r chi.Router) {
		r.Post("/", p.ResolvePublisher)
		r.Get("/", p.ListPublishers)
		r.Get("/{id}", p.GetPublisher)
		r.Put("/{id}/person", p.SetPublisherPerson)
		r.Get("/{id}/videos", p.PublisherVideos)
		r.Post("/{id}/tags", p.AddPublisherTags)
		r.Delete("/{id}/tags/{tag_id}", p.RemovePublisherTag)
	})
	r.Route("/api/v1/persons", func(r chi.Router) {
		r.Post("/", p.CreatePerson)
		r.Get("/", p.ListPersons)
		r.Get("/{id}", p.GetPerson)
		r.Patch("/{id}", p.RenamePerson)
		r.Get("/{id}/publishers", p.PersonPublishers)
		r.Get("/{id}/videos", p.PersonVideos)
		r.Post("/{id}/tags", p.AddPersonTags)
		r.Delete("/{id}/tags/{tag_id}", p.RemovePersonTag)
	})
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
		r.Put("/{video_id}/sources/{source_id}/publisher", p.SetSourcePublisher)
		r.Put("/{video_id}/persons/{person_id}", p.SetVideoPerson)
		r.Delete("/{video_id}/persons/{person_id}", p.SetVideoPerson)
	})
	return r
}
