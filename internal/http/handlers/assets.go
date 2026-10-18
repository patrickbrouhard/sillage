package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// AssetService est partagé par REST et les futures interfaces.
type AssetService interface {
	Start(context.Context, video.VideoID, video.VideoSourceID, int64, string) (asset.Asset, error)
	Get(context.Context, int64) (asset.Asset, error)
	ByRequest(context.Context, string) (asset.Asset, error)
	Open(context.Context, int64) (asset.Asset, asset.Content, error)
}

// AssetHandler adapte le service sans exposer les chemins ni les outils.
type AssetHandler struct{ service AssetService }

// NewAssetHandler utilise le service propriétaire des captures.
func NewAssetHandler(service AssetService) *AssetHandler { return &AssetHandler{service: service} }

type assetResponse struct {
	ID          int64                `json:"id"`
	VideoID     video.VideoID        `json:"video_id"`
	SourceID    *video.VideoSourceID `json:"source_id"`
	TimestampMS *int64               `json:"timestamp_ms"`
	Type        string               `json:"type"`
	Status      string               `json:"status"`
	ErrorCode   string               `json:"error_code"`
	CreatedAt   time.Time            `json:"created_at"`
}

func assetDTO(a asset.Asset) assetResponse {
	return assetResponse{a.ID, a.VideoID, a.SourceID, a.TimestampMS, a.Type, a.Status, a.ErrorCode, a.CreatedAt}
}

// Start accepte une intention idempotente par request_id, distinct de la déduplication métier.
func (h *AssetHandler) Start(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	var input struct {
		TimestampMS *int64 `json:"timestamp_ms"`
		RequestID   string `json:"request_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.TimestampMS == nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, r, 400, "bad_request", "invalid capture request")
		return
	}
	a, err := h.service.Start(r.Context(), videoID, sourceID, *input.TimestampMS, input.RequestID)
	if err != nil {
		respondAssetError(w, r, err)
		return
	}
	requestlog.Fields(r, slog.Int64("asset_id", a.ID), slog.String("operation_id", fmt.Sprintf("capture:%d", a.ID)))
	w.Header().Set("Location", fmt.Sprintf("/api/v1/assets/%d", a.ID))
	status := http.StatusOK
	if a.Status == "pending" {
		status = http.StatusAccepted
	}
	writeJSON(w, r, status, assetDTO(a))
}

// Get consulte l'état sans effet de bord.
func (h *AssetHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, ok := knowledgeID(w, r, "asset_id")
	if !ok {
		return
	}
	a, err := h.service.Get(r.Context(), id)
	if err != nil {
		respondAssetError(w, r, err)
		return
	}
	writeJSON(w, r, 200, assetDTO(a))
}

// ByRequest retrouve une acceptation dont la réponse a été perdue.
func (h *AssetHandler) ByRequest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, err := h.service.ByRequest(r.Context(), chi.URLParam(r, "request_id"))
	if err != nil {
		respondAssetError(w, r, err)
		return
	}
	writeJSON(w, r, 200, assetDTO(a))
}

// Content sert exclusivement les octets d'une identité disponible.
func (h *AssetHandler) Content(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, ok := knowledgeID(w, r, "asset_id")
	if !ok {
		return
	}
	a, content, err := h.service.Open(r.Context(), id)
	if err != nil {
		respondAssetError(w, r, err)
		return
	}
	defer content.Close()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "capture.png", a.CreatedAt, content)
}

func respondAssetError(w http.ResponseWriter, r *http.Request, err error) {
	requestlog.Result(r, "", err)
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case errors.Is(err, asset.ErrNotFound):
		writeError(w, r, 404, "asset_not_found", "asset not found")
	case errors.Is(err, asset.ErrBusy):
		w.Header().Set("Retry-After", "2")
		writeError(w, r, 503, "capture_busy", "another capture is active")
	case errors.Is(err, asset.ErrRequestConflict):
		writeError(w, r, 409, "capture_request_conflict", "request parameters differ")
	case errors.Is(err, asset.ErrUnavailable):
		writeError(w, r, 409, "asset_content_unavailable", "asset content unavailable")
	case errors.Is(err, video.ErrInvalidInput):
		writeError(w, r, 400, "bad_request", "invalid capture request")
	case errors.Is(err, video.ErrVideoNotFound):
		writeError(w, r, 404, "video_not_found", "video not found")
	case errors.Is(err, video.ErrVideoSourceNotFound):
		writeError(w, r, 404, "video_source_not_found", "source not found")
	case errors.Is(err, media.ErrUnsupported):
		writeError(w, r, 409, "capture_source_unsupported", "source unsupported")
	default:
		requestlog.Result(r, "", err)
		writeError(w, r, 500, "internal_error", "internal error")
	}
}
