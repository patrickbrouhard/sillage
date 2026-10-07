package handlers

import (
	"context"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

// TranscriptService fournit les deux cas d'usage réutilisables par les interfaces.
type TranscriptService interface {
	// Fetch acquiert et publie la transcription automatique originale.
	Fetch(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error)
	// Get restitue le dernier contenu local sélectionné, sans accès distant.
	Get(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error)
}

// TranscriptHandler adapte les acquisitions et lectures au contrat HTTP singulier.
type TranscriptHandler struct {
	service TranscriptService
	timeout time.Duration
}

// NewTranscriptHandler configure le délai global d'acquisition.
func NewTranscriptHandler(service TranscriptService, timeout time.Duration) *TranscriptHandler {
	return &TranscriptHandler{service: service, timeout: timeout}
}

// Fetch accepte une commande sans corps et retourne toujours 200 après publication.
func (h *TranscriptHandler) Fetch(w http.ResponseWriter, r *http.Request) {
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	// Aucun Content-Type n'est nécessaire ; un corps fourni n'est jamais ignoré.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1))
	if err != nil || len(body) > 0 {
		writeError(w, 400, "bad_request", "request body must be empty")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	result, err := h.service.Fetch(ctx, videoID, sourceID)
	if err != nil {
		respondTranscriptError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toTranscriptResponse(result))
}

// Get restitue exclusivement le contenu local sélectionné par le service.
func (h *TranscriptHandler) Get(w http.ResponseWriter, r *http.Request) {
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	result, err := h.service.Get(r.Context(), videoID, sourceID)
	if err != nil {
		respondTranscriptError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toTranscriptResponse(result))
}

// transcriptIDs rejette les identifiants invalides avant d'appeler le service.
func transcriptIDs(w http.ResponseWriter, r *http.Request) (video.VideoID, video.VideoSourceID, bool) {
	videoID, videoErr := strconv.ParseInt(chi.URLParam(r, "video_id"), 10, 64)
	sourceID, sourceErr := strconv.ParseInt(chi.URLParam(r, "source_id"), 10, 64)
	if videoErr != nil || sourceErr != nil || videoID <= 0 || sourceID <= 0 {
		writeError(w, 400, "bad_request", "invalid video or source id")
		return 0, 0, false
	}
	return video.VideoID(videoID), video.VideoSourceID(sourceID), true
}

// respondTranscriptError garde les diagnostics techniques dans les logs.
func respondTranscriptError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case errors.Is(err, video.ErrInvalidInput):
		writeError(w, 400, "bad_request", "invalid request")
	case errors.Is(err, video.ErrVideoNotFound):
		writeError(w, 404, "video_not_found", "video not found")
	case errors.Is(err, video.ErrVideoSourceNotFound):
		writeError(w, 404, "video_source_not_found", "video source not found")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, 504, "transcript_fetch_timeout", "transcript fetch timed out")
	case errors.Is(err, transcript.ErrNotFound):
		writeError(w, 404, "transcript_not_found", "transcript not found")
	case errors.Is(err, transcript.ErrNotAvailable):
		writeError(w, 404, "transcript_not_available", "no selectable original automatic caption")
	case errors.Is(err, transcript.ErrFetchFailed):
		log.Printf("transcript fetch failed: %v", err)
		writeError(w, 502, "transcript_fetch_failed", "transcript fetch failed")
	default:
		log.Printf("transcript request failed: %v", err)
		writeError(w, 500, "internal_error", "internal error")
	}
}

type transcriptResponse struct {
	Language      string                   `json:"language"`
	Provenance    string                   `json:"provenance"`
	LastFetchedAt time.Time                `json:"last_fetched_at"`
	Items         []transcriptItemResponse `json:"items"`
}

type transcriptItemResponse struct {
	StartMS int64  `json:"start_ms"`
	Text    string `json:"text"`
}

func toTranscriptResponse(result transcript.Result) transcriptResponse {
	response := transcriptResponse{
		Language:      result.Transcript.Language,
		Provenance:    result.Transcript.Provenance,
		LastFetchedAt: result.Transcript.LastFetchedAt.UTC(),
		Items:         make([]transcriptItemResponse, 0, len(result.Content)),
	}
	for _, item := range result.Content {
		response.Items = append(response.Items, transcriptItemResponse{StartMS: item.StartMS, Text: item.Text})
	}
	return response
}
