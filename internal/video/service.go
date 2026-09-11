package video

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// MetadataProvider extrait une source normalisée sans exposer son format externe.
type MetadataProvider interface {
	// Extract retourne une source, une erreur applicative stable ou l'erreur du contexte.
	// Les erreurs techniques doivent conserver leur cause sans exposer de type d'adapter.
	Extract(ctx context.Context, url string) (VideoSource, error)
}

// Service orchestre les cas d'usage vidéo via des ports indépendants des adapters.
type Service struct {
	repository VideoRepository
	provider   MetadataProvider
}

// NewService relie les ports de persistance et d'extraction du cas d'usage.
func NewService(repository VideoRepository, provider MetadataProvider) *Service {
	return &Service{repository: repository, provider: provider}
}

// AddVideo crée une vidéo ou retrouve celle qui possède déjà l'identité externe.
// Une source existante est retournée sans rafraîchissement de ses métadonnées.
func (s *Service) AddVideo(ctx context.Context, url string) (AddVideoResult, error) {
	source, err := s.provider.Extract(ctx, url)
	if err != nil {
		return AddVideoResult{}, fmt.Errorf("extract video source: %w", err)
	}
	if strings.TrimSpace(source.Provider) == "" || strings.TrimSpace(source.ExternalID) == "" ||
		strings.TrimSpace(source.CanonicalURL) == "" || strings.TrimSpace(source.Title) == "" {
		return AddVideoResult{}, fmt.Errorf("%w: extracted source requires provider, external ID, canonical URL and title", ErrMetadataFetchFailed)
	}
	existing, err := s.repository.FindBySource(ctx, source.Provider, source.ExternalID)
	if err == nil {
		return AddVideoResult{Video: existing}, nil
	}
	if !errors.Is(err, ErrVideoNotFound) {
		return AddVideoResult{}, fmt.Errorf("find video source: %w", err)
	}
	created, err := s.repository.Create(ctx, Video{
		CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
		Sources:   []VideoSource{source},
	})
	if errors.Is(err, ErrSourceAlreadyExists) {
		// Une création concurrente a gagné ; la contrainte SQL a protégé l'identité.
		existing, err = s.repository.FindBySource(ctx, source.Provider, source.ExternalID)
		if err != nil {
			return AddVideoResult{}, fmt.Errorf("find concurrently created video: %w", err)
		}
		return AddVideoResult{Video: existing}, nil
	}
	if err != nil {
		return AddVideoResult{}, fmt.Errorf("create video: %w", err)
	}
	return AddVideoResult{Video: created, Created: true}, nil
}

// AddVideoResult indique si cet appel a créé la vidéo ou retrouvé une vidéo existante.
type AddVideoResult struct {
	Video   Video
	Created bool
}

// GetVideo retourne une vidéo et toutes ses sources, ou ErrVideoNotFound.
func (s *Service) GetVideo(ctx context.Context, id VideoID) (Video, error) {
	if id <= 0 {
		return Video{}, ErrInvalidInput
	}
	return s.repository.Get(ctx, id)
}

// ListVideos retourne toute la bibliothèque, des ajouts les plus récents aux plus anciens.
// Les sources de chaque vidéo sont ordonnées par ID croissant.
func (s *Service) ListVideos(ctx context.Context) ([]Video, error) {
	return s.repository.List(ctx)
}
