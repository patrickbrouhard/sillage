// Package note gère la note principale d'une vidéo sans interpréter son Markdown.
package note

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// ErrNotFound distingue une note absente d'une note enregistrée vide.
var ErrNotFound = errors.New("note not found")

// ErrConflict indique que la note a changé depuis la lecture du client.
var ErrConflict = errors.New("note revision conflict")

// Note appartient directement à une vidéo et conserve le texte fourni.
type Note struct {
	VideoID   video.VideoID
	Revision  int64
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
	// Save compare la révision attendue atomiquement et préserve created_at et les deux dates lorsque le contenu est identique.
	Save(context.Context, video.VideoID, string, int64, time.Time) (SaveResult, error)
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

// Save accepte le texte vide, refuse le texte non UTF-8 et normalise uniquement les fins de ligne en LF.
func (s *Service) Save(ctx context.Context, id video.VideoID, content string, expectedRevision int64) (SaveResult, error) {
	if id <= 0 || expectedRevision < 0 || !utf8.ValidString(content) {
		return SaveResult{}, video.ErrInvalidInput
	}
	// Traiter CRLF avant CR évite de produire deux sauts de ligne pour une seule fin de ligne.
	content = strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	return s.repository.Save(ctx, id, content, expectedRevision, time.Now().UTC().Truncate(time.Millisecond))
}
