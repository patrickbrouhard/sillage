// Package http assemble les routes de l'API REST.
package http

import (
	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/http/handlers"
	"net/http"
	"time"
)

// NewRouter expose les trois opérations vidéo sous le préfixe versionné.
func NewRouter(service handlers.VideoService, postTimeout time.Duration) http.Handler {
	r := chi.NewRouter()
	h := handlers.NewVideoHandler(service, postTimeout)
	r.Route("/api/v1/videos", func(r chi.Router) {
		r.Post("/", h.Add)
		r.Get("/", h.List)
		r.Get("/{id}", h.Get)
	})
	return r
}
