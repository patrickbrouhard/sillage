// Package note gère la note principale d'une vidéo sans interpréter son Markdown.
package note

import (
	"context"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// ErrNotFound distingue une note absente d'une note enregistrée vide.
var ErrNotFound = errors.New("note not found")

// Note appartient directement à une vidéo et conserve le texte fourni.
type Note struct {
	VideoID   video.VideoID
	ContentMD string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// SaveResult distingue la première sauvegarde des remplacements, même identiques.
type SaveResult struct {
	Note    Note
	Created bool
}

// Repository garantit le cycle de vie atomique de la note et vérifie la vidéo.
type Repository interface {
	// Get retourne ErrNotFound ou video.ErrVideoNotFound selon la ressource absente.
	Get(context.Context, video.VideoID) (Note, error)
	// Save préserve created_at et les deux dates lorsque le contenu est identique.
	Save(context.Context, video.VideoID, string, time.Time) (SaveResult, error)
}

// Service expose les sauvegardes locales indépendamment de HTTP et du stockage.
type Service struct{ repository Repository }

// NewService assemble le port de persistance.
func NewService(repository Repository) *Service { return &Service{repository: repository} }

// Get lit la note sans acquisition distante.
func (s *Service) Get(ctx context.Context, id video.VideoID) (Note, error) {
	if id <= 0 {
		return Note{}, video.ErrInvalidInput
	}
	return s.repository.Get(ctx, id)
}

// Save accepte le texte vide et refuse le texte non UTF-8 sans jamais le transformer.
func (s *Service) Save(ctx context.Context, id video.VideoID, content string) (SaveResult, error) {
	if id <= 0 || !utf8.ValidString(content) {
		return SaveResult{}, video.ErrInvalidInput
	}
	return s.repository.Save(ctx, id, content, time.Now().UTC().Truncate(time.Millisecond))
}
