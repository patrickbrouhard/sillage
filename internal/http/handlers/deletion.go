package handlers

import (
	"context"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/video"
	"log/slog"
	"net/http"
	"strconv"
)

// DeletionService supprime une vidéo ou reprend sa purge physique.
type DeletionService interface {
	// Delete distingue une purge en attente d'un résultat complet.
	Delete(context.Context, video.VideoID) (bool, error)
}

// DeleteVideo adapte la commande idempotente sans exposer le manifeste interne.
func DeleteVideo(service DeletionService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		requestlog.Route(r, "/api/v1/videos/{id}")
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			writeError(w, r, 400, "bad_request", "invalid video id")
			return
		}
		requestlog.Fields(r, slog.Int64("video_id", id))
		pending, err := service.Delete(r.Context(), video.VideoID(id))
		switch {
		case errors.Is(err, video.ErrBusy):
			writeError(w, r, 409, "video_busy", "video is currently in use")
		case errors.Is(err, video.ErrInvalidInput):
			writeError(w, r, 400, "bad_request", "invalid video id")
		case err != nil:
			requestlog.Result(r, "", err)
			writeError(w, r, 500, "internal_error", "deletion could not be confirmed")
		case pending:
			writeJSON(w, r, 202, struct {
				Status string `json:"status"`
			}{Status: "purge_pending"})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}
}
