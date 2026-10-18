package handlers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// MediaService expose les commandes indépendantes du transport.
type MediaService interface {
	// Start accepte ou retrouve l’acquisition possédée par le serveur.
	Start(context.Context, video.VideoID, video.VideoSourceID) (media.State, error)
	// Get consulte uniquement les données et fichiers locaux.
	Get(context.Context, video.VideoID, video.VideoSourceID) (media.State, error)
	// Delete retire uniquement l’identité de fichier demandée.
	Delete(context.Context, video.VideoID, int64) error
}

// MediaHandler traduit les états sans exposer les chemins ni les diagnostics des outils.
type MediaHandler struct{ service MediaService }

// NewMediaHandler partage le service possédant les opérations du serveur.
func NewMediaHandler(service MediaService) *MediaHandler { return &MediaHandler{service: service} }

type mediaResponse struct {
	VideoCodec    *string   `json:"video_codec"`
	AudioCodec    *string   `json:"audio_codec"`
	Width         *int      `json:"width"`
	Height        *int      `json:"height"`
	FPS           *float64  `json:"fps"`
	AudioLanguage *string   `json:"audio_language"`
	ID            int64     `json:"id"`
	Format        string    `json:"format"`
	Size          int64     `json:"size"`
	DurationMS    int64     `json:"duration_ms"`
	AddedAt       time.Time `json:"added_at"`
}
type downloadResponse struct {
	Status    string         `json:"status"`
	MediaFile *mediaResponse `json:"media_file"`
	Error     *downloadError `json:"error"`
}
type downloadError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func mediaDTO(f *media.File) *mediaResponse {
	if f == nil {
		return nil
	}
	return &mediaResponse{
		ID: f.ID, Format: f.Format, Size: f.Size, DurationMS: f.DurationMS, AddedAt: f.AddedAt,
		VideoCodec: f.VideoCodec, AudioCodec: f.AudioCodec,
		Width: f.Width, Height: f.Height, FPS: f.FPS, AudioLanguage: f.AudioLanguage,
	}
}

func downloadDTO(state media.State) downloadResponse {
	result := downloadResponse{Status: state.Status, MediaFile: mediaDTO(state.File)}
	if state.ErrorCode != "" {
		result.Error = &downloadError{Code: state.ErrorCode, Message: "download did not complete"}
	}
	return result
}

// Start accepte une commande sans corps ; le 202 ne dépend pas de la durée du téléchargement.
func (h *MediaHandler) Start(w http.ResponseWriter, r *http.Request) {
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1))
	if err != nil || len(body) > 0 {
		writeError(w, r, 400, "bad_request", "request body must be empty")
		return
	}
	state, err := h.service.Start(r.Context(), videoID, sourceID)
	if err != nil {
		respondMediaError(w, r, state, err)
		return
	}
	status := http.StatusOK
	if state.Status == "downloading" {
		status = http.StatusAccepted
		w.Header().Set("Location", r.URL.Path)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, r, status, downloadDTO(state))
}

// Get lit uniquement l'état local ; un fichier disparu n'est jamais assimilé à une absence.
func (h *MediaHandler) Get(w http.ResponseWriter, r *http.Request) {
	videoID, sourceID, ok := transcriptIDs(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	state, err := h.service.Get(r.Context(), videoID, sourceID)
	if err != nil {
		respondMediaError(w, r, state, err)
		return
	}
	writeJSON(w, r, 200, downloadDTO(state))
}

// Delete cible un fichier précis et ne supprime aucune connaissance associée.
func (h *MediaHandler) Delete(w http.ResponseWriter, r *http.Request) {
	videoID, e1 := strconv.ParseInt(chi.URLParam(r, "video_id"), 10, 64)
	fileID, e2 := strconv.ParseInt(chi.URLParam(r, "media_file_id"), 10, 64)
	if e1 != nil || e2 != nil || videoID <= 0 || fileID <= 0 {
		writeError(w, r, 400, "bad_request", "invalid media id")
		return
	}
	if err := h.service.Delete(r.Context(), video.VideoID(videoID), fileID); err != nil {
		respondMediaError(w, r, media.State{}, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func respondMediaError(w http.ResponseWriter, r *http.Request, state media.State, err error) {
	if errors.Is(err, context.Canceled) && errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case errors.Is(err, video.ErrInvalidInput):
		writeError(w, r, 400, "bad_request", "invalid request")
	case errors.Is(err, video.ErrVideoNotFound):
		writeError(w, r, 404, "video_not_found", "video not found")
	case errors.Is(err, video.ErrVideoSourceNotFound):
		writeError(w, r, 404, "video_source_not_found", "video source not found")
	case errors.Is(err, media.ErrNotFound):
		writeError(w, r, 404, "media_file_not_found", "media file not found")
	case errors.Is(err, media.ErrUnsupported):
		writeError(w, r, 409, "media_source_unsupported", "source is not supported")
	case errors.Is(err, media.ErrBusy):
		w.Header().Set("Retry-After", "3")
		writeError(w, r, 503, "download_busy", "another download is active")
	case errors.Is(err, media.ErrUnavailable):
		if err != media.ErrUnavailable {
			requestlog.Result(r, "", err)
		}
		requestlog.Response(r, 409, "local_media_unavailable")
		if errors.Is(r.Context().Err(), context.Canceled) {
			return
		}
		writeJSON(w, r, 409, struct {
			Error     downloadError  `json:"error"`
			MediaFile *mediaResponse `json:"media_file"`
		}{downloadError{"local_media_unavailable", "local file is unavailable"}, mediaDTO(state.File)})
	default:
		requestlog.Result(r, "", err)
		writeError(w, r, 500, "internal_error", "internal error")
	}
}
