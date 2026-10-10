package video

import (
	"context"
	"errors"
	"strings"
)

// PublisherID identifie un compte de publication dans Sillage.
type PublisherID int64

// Publisher décrit un compte externe, sans attribuer la qualité d'auteur.
// Name vide signifie que le nom affichable est inconnu.
type Publisher struct {
	ID         PublisherID
	Provider   string
	ExternalID string
	Name       string
	PersonID   *PersonID
	Tags       []Tag
}

// ErrPublisherNotFound indique un compte absent du catalogue.
var ErrPublisherNotFound = errors.New("publisher not found")

// PublisherResult distingue la création d'une simple réutilisation sans refresh.
type PublisherResult struct {
	Publisher Publisher
	Created   bool
}

// PublisherProvider résout une URL de compte en métadonnées normalisées.
type PublisherProvider interface {
	ResolvePublisher(context.Context, string) (Publisher, error)
}

// PublisherRepository persiste les comptes et leurs associations explicites.
type PublisherRepository interface {
	CreateOrFind(context.Context, Publisher) (PublisherResult, error)
	Get(context.Context, PublisherID) (Publisher, error)
	List(context.Context) ([]Publisher, error)
	SetPerson(context.Context, PublisherID, *PersonID) error
	SetSource(context.Context, VideoID, VideoSourceID, *PublisherID) error
	Videos(context.Context, PublisherID) ([]Video, error)
	AddTags(context.Context, PublisherID, []TagName) ([]Tag, error)
	RemoveTag(context.Context, PublisherID, TagID) error
}

// PublisherService expose les comptes sans dépendre des interfaces externes.
type PublisherService struct {
	repository PublisherRepository
	provider   PublisherProvider
}

// NewPublisherService assemble la résolution et la persistance spécialisées.
func NewPublisherService(r PublisherRepository, p PublisherProvider) *PublisherService {
	return &PublisherService{repository: r, provider: p}
}

// Resolve crée ou retrouve un compte identifié ; aucune personne n'est inférée.
func (s *PublisherService) Resolve(ctx context.Context, url string) (PublisherResult, error) {
	if strings.TrimSpace(url) == "" {
		return PublisherResult{}, ErrInvalidInput
	}
	p, err := s.provider.ResolvePublisher(ctx, url)
	if err != nil {
		return PublisherResult{}, err
	}
	if p.Provider != "youtube" || strings.TrimSpace(p.ExternalID) == "" {
		return PublisherResult{}, ErrMetadataFetchFailed
	}
	// Les identités internes et relations utilisateur ne proviennent jamais du provider.
	p.ID, p.PersonID, p.Tags = 0, nil, nil
	return s.repository.CreateOrFind(ctx, p)
}

// Get relit localement un publisher identifié.
func (s *PublisherService) Get(ctx context.Context, id PublisherID) (Publisher, error) {
	if id <= 0 {
		return Publisher{}, ErrInvalidInput
	}
	return s.repository.Get(ctx, id)
}

// List retourne le catalogue local dans l'ordre des identifiants.
func (s *PublisherService) List(ctx context.Context) ([]Publisher, error) {
	return s.repository.List(ctx)
}

// SetPerson remplace ou retire explicitement la personne de référence.
func (s *PublisherService) SetPerson(ctx context.Context, id PublisherID, person *PersonID) error {
	if id <= 0 || (person != nil && *person <= 0) {
		return ErrInvalidInput
	}
	return s.repository.SetPerson(ctx, id, person)
}

// SetSource remplace ou retire le compte de publication d'une source de la vidéo.
func (s *PublisherService) SetSource(ctx context.Context, id VideoID, source VideoSourceID, publisher *PublisherID) error {
	if id <= 0 || source <= 0 || (publisher != nil && *publisher <= 0) {
		return ErrInvalidInput
	}
	return s.repository.SetSource(ctx, id, source, publisher)
}

// Videos retrouve les vidéos du compte sans dupliquer celles ayant plusieurs sources.
func (s *PublisherService) Videos(ctx context.Context, id PublisherID) ([]Video, error) {
	if id <= 0 {
		return nil, ErrInvalidInput
	}
	return s.repository.Videos(ctx, id)
}

// AddTags ajoute un lot validé sans modifier les tags d'autres entités.
func (s *PublisherService) AddTags(ctx context.Context, id PublisherID, names []string) ([]Tag, error) {
	if id <= 0 {
		return nil, ErrInvalidInput
	}
	values, err := NormalizeTagNames(names)
	if err != nil {
		return nil, err
	}
	return s.repository.AddTags(ctx, id, values)
}

// RemoveTag retire uniquement l'association au publisher.
func (s *PublisherService) RemoveTag(ctx context.Context, id PublisherID, tag TagID) error {
	if id <= 0 || tag <= 0 {
		return ErrInvalidInput
	}
	return s.repository.RemoveTag(ctx, id, tag)
}
