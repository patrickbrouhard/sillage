package video

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// PersonID identifie une personne indépendamment de son nom et des plateformes.
type PersonID int64

// Person représente une personne physique ; les homonymes restent distincts.
type Person struct {
	ID   PersonID
	Name string
	Tags []Tag
}

// ErrPersonNotFound indique une personne absente de la base.
var ErrPersonNotFound = errors.New("person not found")

// PersonRepository conserve les personnes et leurs associations sans rôles.
type PersonRepository interface {
	// Create attribue une nouvelle identité sans rechercher les homonymes.
	Create(context.Context, string) (Person, error)
	// Rename préserve l'identité et les relations existantes.
	Rename(context.Context, PersonID, string) (Person, error)
	// Get retourne les tags propres ou ErrPersonNotFound.
	Get(context.Context, PersonID) (Person, error)
	// List inclut les personnes sans associations, par ID croissant.
	List(context.Context) ([]Person, error)
	// SetVideo vérifie les deux identités et modifie le seul lien direct.
	SetVideo(context.Context, VideoID, PersonID, bool) error
	// Publishers ne confond pas personne de référence et propriétaire juridique.
	Publishers(context.Context, PersonID) ([]Publisher, error)
	// Videos distingue direct, publisher et all ; les vidéos restent dédupliquées.
	Videos(context.Context, PersonID, string) ([]Video, error)
	// AddTags garantit l'atomicité du lot et la conservation des associations existantes.
	AddTags(context.Context, PersonID, []TagName) ([]Tag, error)
	// RemoveTag retire uniquement le lien, même s'il est déjà absent.
	RemoveTag(context.Context, PersonID, TagID) error
}

// PersonService expose les opérations locales sur les personnes.
type PersonService struct{ repository PersonRepository }

// NewPersonService assemble le port de persistance des personnes.
func NewPersonService(r PersonRepository) *PersonService { return &PersonService{repository: r} }

// Create crée une nouvelle identité même lorsqu'un homonyme existe.
func (s *PersonService) Create(ctx context.Context, name string) (Person, error) {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) {
		return Person{}, ErrInvalidInput
	}
	return s.repository.Create(ctx, name)
}

// Rename corrige le nom sans changer l'identité ni fusionner les homonymes.
func (s *PersonService) Rename(ctx context.Context, id PersonID, name string) (Person, error) {
	name = strings.TrimSpace(name)
	if id <= 0 || name == "" || !utf8.ValidString(name) {
		return Person{}, ErrInvalidInput
	}
	return s.repository.Rename(ctx, id, name)
}

// Get relit une personne et ses tags explicites.
func (s *PersonService) Get(ctx context.Context, id PersonID) (Person, error) {
	if id <= 0 {
		return Person{}, ErrInvalidInput
	}
	return s.repository.Get(ctx, id)
}

// List retourne toutes les personnes par identifiant croissant.
func (s *PersonService) List(ctx context.Context) ([]Person, error) { return s.repository.List(ctx) }

// SetVideo ajoute ou retire une association explicite, sans inférence de rôle.
func (s *PersonService) SetVideo(ctx context.Context, id VideoID, person PersonID, present bool) error {
	if id <= 0 || person <= 0 {
		return ErrInvalidInput
	}
	return s.repository.SetVideo(ctx, id, person, present)
}

// Publishers retrouve les comptes dont cette personne est la référence.
func (s *PersonService) Publishers(ctx context.Context, id PersonID) ([]Publisher, error) {
	if id <= 0 {
		return nil, ErrInvalidInput
	}
	return s.repository.Publishers(ctx, id)
}

// Videos distingue les liens directs, ceux des publishers et leur union dédupliquée.
func (s *PersonService) Videos(ctx context.Context, id PersonID, relation string) ([]Video, error) {
	if id <= 0 || (relation != "direct" && relation != "publisher" && relation != "all") {
		return nil, ErrInvalidInput
	}
	return s.repository.Videos(ctx, id, relation)
}

// AddTags conserve l'identité commune du catalogue et valide le lot entier.
func (s *PersonService) AddTags(ctx context.Context, id PersonID, names []string) ([]Tag, error) {
	if id <= 0 {
		return nil, ErrInvalidInput
	}
	values, err := NormalizeTagNames(names)
	if err != nil {
		return nil, err
	}
	return s.repository.AddTags(ctx, id, values)
}

// RemoveTag retire uniquement l'association à la personne.
func (s *PersonService) RemoveTag(ctx context.Context, id PersonID, tag TagID) error {
	if id <= 0 || tag <= 0 {
		return ErrInvalidInput
	}
	return s.repository.RemoveTag(ctx, id, tag)
}
