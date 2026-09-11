// Package handlers adapte les cas d'usage vidéo au contrat HTTP.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// VideoService fournit les cas d'usage consommés par l'API.
type VideoService interface {
	// AddVideo crée ou retrouve une vidéo.
	AddVideo(context.Context, string) (video.AddVideoResult, error)
	// GetVideo relit une vidéo avec ses sources.
	GetVideo(context.Context, video.VideoID) (video.Video, error)
	// ListVideos retourne la bibliothèque dans l'ordre des ajouts récents.
	ListVideos(context.Context) ([]video.Video, error)
}

// VideoHandler traduit les requêtes et résultats sans connaître les adapters techniques.
type VideoHandler struct {
	service     VideoService
	postTimeout time.Duration
}

// NewVideoHandler configure les cas d'usage et le délai maximal d'ajout.
func NewVideoHandler(service VideoService, postTimeout time.Duration) *VideoHandler {
	return &VideoHandler{service: service, postTimeout: postTimeout}
}

type addVideoRequest struct {
	URL string `json:"url"`
}

// Add accepte un seul objet JSON et retourne la vidéo créée ou déjà présente.
func (h *VideoHandler) Add(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "content type must be application/json")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input *addVideoRequest
	err = decoder.Decode(&input)
	if err == nil {
		var extra any
		if next := decoder.Decode(&extra); next != io.EOF {
			if next == nil {
				err = errors.New("multiple JSON values")
			} else {
				err = next
			}
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds 16 KiB")
		} else {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		}
		return
	}
	if input == nil || strings.TrimSpace(input.URL) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "url is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.postTimeout)
	defer cancel()
	result, err := h.service.AddVideo(ctx, strings.TrimSpace(input.URL))
	if err != nil {
		respondError(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
		w.Header().Set("Location", "/api/v1/videos/"+strconv.FormatInt(int64(result.Video.ID), 10))
	}
	writeJSON(w, status, toVideoResponse(result.Video))
}

// Get retourne une vidéo identifiée par un entier strictement positif.
func (h *VideoHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid video id")
		return
	}
	v, err := h.service.GetVideo(r.Context(), video.VideoID(id))
	if err != nil {
		respondError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toVideoResponse(v))
}

// List retourne toutes les vidéos dans l'enveloppe de bibliothèque.
func (h *VideoHandler) List(w http.ResponseWriter, r *http.Request) {
	videos, err := h.service.ListVideos(r.Context())
	if err != nil {
		respondError(w, r, err)
		return
	}
	response := videoListResponse{Videos: make([]videoResponse, 0, len(videos))}
	for _, v := range videos {
		response.Videos = append(response.Videos, toVideoResponse(v))
	}
	writeJSON(w, http.StatusOK, response)
}

func respondError(w http.ResponseWriter, r *http.Request, err error) {
	// Une déconnexion n'appelle aucune réponse HTTP ni erreur technique supplémentaire.
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case errors.Is(err, video.ErrInvalidInput):
		writeError(w, 400, "bad_request", "invalid video URL")
	case errors.Is(err, video.ErrVideoNotFound):
		writeError(w, 404, "video_not_found", "video not found")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, 504, "metadata_fetch_timeout", "metadata fetch timed out")
	case errors.Is(err, video.ErrMetadataFetchFailed):
		log.Printf("metadata fetch failed: %v", err)
		writeError(w, 502, "metadata_fetch_failed", "metadata fetch failed")
	default:
		log.Printf("request failed: %v", err)
		writeError(w, 500, "internal_error", "internal error")
	}
}

type errorResponse struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorResponse{Error: errorBody{Code: code, Message: message}})
}

// writeJSON encode avant les en-têtes pour éviter une réponse de succès partiellement encodée.
func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		log.Printf("encode response: %v", err)
		status = http.StatusInternalServerError
		data = []byte(`{"error":{"code":"internal_error","message":"internal error"}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(append(data, '\n')); err != nil {
		log.Printf("write response: %v", err)
	}
}
