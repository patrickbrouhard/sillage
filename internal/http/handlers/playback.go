package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// PlaybackService expose la reprise indépendamment du transport.
type PlaybackService interface {
	// Get consulte le point sans acquisition ni écriture.
	Get(context.Context, video.VideoID, video.VideoSourceID) (*int64, error)
	// Save remplace le point ; nil demande son effacement.
	Save(context.Context, video.VideoID, video.VideoSourceID, *int64) error
}

// PlaybackHandler traduit les lectures et remplacements de progression.
type PlaybackHandler struct{ service PlaybackService }

// NewPlaybackHandler assemble le service de reprise.
func NewPlaybackHandler(service PlaybackService) *PlaybackHandler {
	return &PlaybackHandler{service: service}
}

// Get retourne explicitement null en l'absence de point de reprise.
func (h *PlaybackHandler) Get(w http.ResponseWriter, r *http.Request) {
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	position, err := h.service.Get(r.Context(), videoID, sourceID)
	if err != nil {
		respondTranscriptError(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, struct {
		Position *int64 `json:"position_ms"`
	}{position})
}

// Put exige le champ position_ms ; null demande l'effacement, zéro reste valide.
func (h *PlaybackHandler) Put(w http.ResponseWriter, r *http.Request) {
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	var input struct {
		Position json.RawMessage `json:"position_ms"`
	}
	if !readKnowledgeJSON(w, r, 1024, &input) {
		return
	}
	var position *int64
	if len(input.Position) == 0 || json.Unmarshal(input.Position, &position) != nil {
		writeError(w, r, 400, "bad_request", "position_ms is required and must be an integer or null")
		return
	}
	if err := h.service.Save(r.Context(), videoID, sourceID, position); err != nil {
		respondTranscriptError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
