package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// NoteService expose les opérations réutilisables sur la note principale.
type NoteService interface {
	// Get distingue la note absente de la vidéo absente.
	Get(context.Context, video.VideoID) (note.Note, error)
	// Save crée ou remplace le contenu brut sans modifier les sauvegardes identiques.
	Save(context.Context, video.VideoID, string) (note.SaveResult, error)
}

// TagService expose le catalogue et les associations indépendamment de HTTP.
type TagService interface {
	// List restitue tous les tags par ID croissant.
	List(context.Context) ([]video.Tag, error)
	// Add associe les noms et retourne tous les tags de la vidéo.
	Add(context.Context, video.VideoID, []string) ([]video.Tag, error)
	// Remove retire une association de manière idempotente.
	Remove(context.Context, video.VideoID, video.TagID) error
}

// KnowledgeHandler adapte les opérations locales de notes et de classement.
type KnowledgeHandler struct {
	notes NoteService
	tags  TagService
}

// NewKnowledgeHandler assemble les services sans dépendance au stockage.
func NewKnowledgeHandler(notes NoteService, tags TagService) *KnowledgeHandler {
	return &KnowledgeHandler{notes: notes, tags: tags}
}

type noteResponse struct {
	VideoID   video.VideoID `json:"video_id"`
	ContentMD string        `json:"content_md"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

func toNoteResponse(n note.Note) noteResponse {
	return noteResponse{VideoID: n.VideoID, ContentMD: n.ContentMD, CreatedAt: n.CreatedAt.UTC(), UpdatedAt: n.UpdatedAt.UTC()}
}

type tagResponse struct {
	ID   video.TagID `json:"id"`
	Name string      `json:"name"`
}

type tagsResponse struct {
	Tags []tagResponse `json:"tags"`
}

func toTagResponses(tags []video.Tag) []tagResponse {
	result := make([]tagResponse, 0, len(tags))
	for _, tag := range tags {
		result = append(result, tagResponse{ID: tag.ID, Name: tag.Name})
	}
	return result
}

// GetNote lit une note sans incorporer son contenu à la représentation vidéo.
func (h *KnowledgeHandler) GetNote(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	result, err := h.notes.Get(r.Context(), video.VideoID(id))
	if err != nil {
		respondKnowledgeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toNoteResponse(result))
}

// PutNote exige une chaîne explicite, y compris pour créer une note vide.
func (h *KnowledgeHandler) PutNote(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		ContentMD *string `json:"content_md"`
	}
	if !readKnowledgeJSON(w, r, 1024*1024, &input) {
		return
	}
	if input.ContentMD == nil {
		writeError(w, 400, "bad_request", "content_md must be a string")
		return
	}
	result, err := h.notes.Save(r.Context(), video.VideoID(id), *input.ContentMD)
	if err != nil {
		respondKnowledgeError(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
		w.Header().Set("Location", "/api/v1/videos/"+strconv.FormatInt(id, 10)+"/note")
	}
	writeJSON(w, status, toNoteResponse(result.Note))
}

// ListTags inclut les tags qui ne sont plus associés à aucune vidéo.
func (h *KnowledgeHandler) ListTags(w http.ResponseWriter, r *http.Request) {
	result, err := h.tags.List(r.Context())
	if err != nil {
		respondKnowledgeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tagsResponse{Tags: toTagResponses(result)})
}

// AddTags traduit une liste de noms sans décider de leur normalisation métier.
func (h *KnowledgeHandler) AddTags(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Names []string `json:"names"`
	}
	if !readKnowledgeJSON(w, r, 64*1024, &input) {
		return
	}
	result, err := h.tags.Add(r.Context(), video.VideoID(id), input.Names)
	if err != nil {
		respondKnowledgeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tagsResponse{Tags: toTagResponses(result)})
}

// RemoveTag retire uniquement l'association, sans corps de réponse.
func (h *KnowledgeHandler) RemoveTag(w http.ResponseWriter, r *http.Request) {
	id, ok := knowledgeID(w, r, "id")
	if !ok {
		return
	}
	tagID, ok := knowledgeID(w, r, "tag_id")
	if !ok {
		return
	}
	if err := h.tags.Remove(r.Context(), video.VideoID(id), video.TagID(tagID)); err != nil {
		respondKnowledgeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func knowledgeID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, 400, "bad_request", "invalid id")
		return 0, false
	}
	return id, true
}

// readKnowledgeJSON borne le corps et refuse toute réparation Unicode silencieuse.
func readKnowledgeJSON(w http.ResponseWriter, r *http.Request, limit int64, input any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, 415, "unsupported_media_type", "content type must be application/json")
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, "payload_too_large", "request body too large")
		} else {
			writeError(w, 400, "bad_request", "invalid request body")
		}
		return false
	}
	if !json.Valid(body) || !utf8.Valid(body) || !validUnicodeEscapes(body) {
		writeError(w, 400, "bad_request", "invalid JSON or Unicode")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(input); err != nil {
		writeError(w, 400, "bad_request", "invalid request body")
		return false
	}
	return true
}

// validUnicodeEscapes complète json.Valid : les surrogates UTF-16 doivent être appariés.
// Les doubles antislashs sont sautés, car ils représentent du texte littéral.
func validUnicodeEscapes(body []byte) bool {
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' {
			continue
		}
		i++
		if body[i] != 'u' {
			continue
		}
		value, _ := strconv.ParseUint(string(body[i+1:i+5]), 16, 16)
		i += 4
		if value >= 0xDC00 && value <= 0xDFFF {
			return false
		}
		if value < 0xD800 || value > 0xDBFF {
			continue
		}
		if i+6 >= len(body) || body[i+1] != '\\' || body[i+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(body[i+3:i+7]), 16, 16)
		if err != nil || low < 0xDC00 || low > 0xDFFF {
			return false
		}
		i += 6
	}
	return true
}

// respondKnowledgeError ne traduit jamais une erreur locale en échec d'acquisition distante.
func respondKnowledgeError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	switch {
	case errors.Is(err, video.ErrInvalidInput):
		writeError(w, 400, "bad_request", "invalid request")
	case errors.Is(err, video.ErrVideoNotFound):
		writeError(w, 404, "video_not_found", "video not found")
	case errors.Is(err, note.ErrNotFound):
		writeError(w, 404, "note_not_found", "note not found")
	default:
		log.Printf("knowledge request failed: %v", err)
		writeError(w, 500, "internal_error", "internal error")
	}
}
