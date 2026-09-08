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
	Extract(ctx context.Context, url string) (VideoSource, error)
}

// Service orchestre l'ajout de vidéos via des ports indépendants des adapters.
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
func (s *Service) AddVideo(ctx context.Context, url string) (Video, error) {
	source, err := s.provider.Extract(ctx, url)
	if err != nil {
		return Video{}, fmt.Errorf("extract video source: %w", err)
	}
	if strings.TrimSpace(source.Provider) == "" || strings.TrimSpace(source.ExternalID) == "" ||
		strings.TrimSpace(source.CanonicalURL) == "" || strings.TrimSpace(source.Title) == "" {
		return Video{}, fmt.Errorf("extracted source requires provider, external ID, canonical URL and title")
	}
	existing, err := s.repository.FindBySource(ctx, source.Provider, source.ExternalID)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, ErrVideoNotFound) {
		return Video{}, fmt.Errorf("find video source: %w", err)
	}
	created, err := s.repository.Create(ctx, Video{
		CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
		Sources:   []VideoSource{source},
	})
	if errors.Is(err, ErrSourceAlreadyExists) {
		// Une création concurrente a gagné ; la contrainte SQL a protégé l'identité.
		existing, err = s.repository.FindBySource(ctx, source.Provider, source.ExternalID)
		if err != nil {
			return Video{}, fmt.Errorf("find concurrently created video: %w", err)
		}
		return existing, nil
	}
	if err != nil {
		return Video{}, fmt.Errorf("create video: %w", err)
	}
	return created, nil
}
