// Package playback conserve le point de reprise d'une source, sans historique de visionnage.
package playback

import (
	"context"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// Repository vérifie l'appartenance vidéo/source et applique les mutations atomiquement.
type Repository interface {
	// Get retourne nil si la source existe sans point de reprise.
	Get(context.Context, video.VideoID, video.VideoSourceID) (*int64, error)
	// Save remplace le point ; nil demande son effacement.
	Save(context.Context, video.VideoID, video.VideoSourceID, *int64) error
}

// Service porte la lecture et le remplacement du point de reprise.
type Service struct{ repository Repository }

// NewService assemble la persistance sans accès réseau.
func NewService(repository Repository) *Service { return &Service{repository: repository} }

// Get retourne nil quand la source ne possède aucun point de reprise.
func (s *Service) Get(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID) (*int64, error) {
	if videoID <= 0 || sourceID <= 0 {
		return nil, video.ErrInvalidInput
	}
	return s.repository.Get(ctx, videoID, sourceID)
}

// Save remplace la position ; nil efface uniquement le point de reprise.
// La qualification de lecture appartient au navigateur, qui seul observe le média.
func (s *Service) Save(ctx context.Context, videoID video.VideoID, sourceID video.VideoSourceID, position *int64) error {
	if videoID <= 0 || sourceID <= 0 || (position != nil && (*position < 0 || *position > 9007199254740991)) {
		return video.ErrInvalidInput
	}
	return s.repository.Save(ctx, videoID, sourceID, position)
}
