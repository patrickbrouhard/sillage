// Package http assemble les routes de l'API REST.
package http

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/http/handlers"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
)

// NewRouter expose vidéos, notes, tags et transcriptions sous le préfixe versionné.
func NewRouter(
	downloads handlers.MediaService,
	publishers handlers.PublisherService,
	persons handlers.PersonService,
	notes handlers.NoteService,
	tags handlers.TagService,
	transcripts handlers.TranscriptService,
	service handlers.VideoService,
	postTimeout time.Duration,
	captures ...handlers.AssetService,
) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				pattern := chi.RouteContext(r.Context()).RoutePattern()
				requestlog.Route(r, pattern)
				for _, name := range []string{"video_id", "source_id", "asset_id", "media_file_id", "tag_id", "person_id"} {
					if id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64); err == nil && id > 0 {
						requestlog.Fields(r, slog.Int64(name, id))
					}
				}
				if id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64); err == nil && id > 0 {
					for prefix, name := range map[string]string{"/api/v1/videos/": "video_id", "/api/v1/publishers/": "publisher_id", "/api/v1/persons/": "person_id"} {
						if strings.HasPrefix(pattern, prefix) {
							requestlog.Fields(r, slog.Int64(name, id))
							break
						}
					}
				}
			}()
			next.ServeHTTP(w, r)
		})
	})
	h := handlers.NewVideoHandler(service, postTimeout)
	t := handlers.NewTranscriptHandler(transcripts, postTimeout)
	k := handlers.NewKnowledgeHandler(notes, tags)
	p := handlers.NewPeopleHandler(publishers, persons, postTimeout)
	if len(captures) > 0 && captures[0] != nil {
		a := handlers.NewAssetHandler(captures[0])
		r.Post("/api/v1/videos/{video_id}/sources/{source_id}/captures", a.Start)
		r.Get("/api/v1/assets/requests/{request_id}", a.ByRequest)
		r.Get("/api/v1/assets/{asset_id}", a.Get)
		r.Get("/api/v1/assets/{asset_id}/content", a.Content)
	}
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
		if downloads != nil {
			m := handlers.NewMediaHandler(downloads)
			r.Post("/{video_id}/sources/{source_id}/download", m.Start)
			r.Get("/{video_id}/sources/{source_id}/download", m.Get)
			r.Delete("/{video_id}/media-files/{media_file_id}", m.Delete)
		}
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
