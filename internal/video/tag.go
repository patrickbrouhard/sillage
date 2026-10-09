package video

import (
	"context"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// TagID identifie un tag partagé entre vidéos.
type TagID int64

// Tag conserve le nom d'affichage initial, indépendamment de son identité Unicode.
type Tag struct {
	ID   TagID
	Name string
}

// MaxTagNameRunes borne chaque nom après suppression des espaces aux extrémités.
const MaxTagNameRunes = 200

// TagName transporte un nom validé et sa clé d'identité canonique.
type TagName struct {
	Name string
	Key  string
}

// NormalizeTagName conserve l'affichage et calcule une identité NFC sans casse.
// Le repli Unicode complet est indépendant de la locale, sans NFKC ni suppression d'accents.
func NormalizeTagName(name string) (TagName, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || name == "" || utf8.RuneCountInString(name) > MaxTagNameRunes {
		return TagName{}, ErrInvalidInput
	}
	// Le repli peut décomposer des caractères : rétablir NFC après celui-ci.
	key := norm.NFC.String(cases.Fold().String(norm.NFC.String(name)))
	return TagName{Name: name, Key: key}, nil
}

// TagRepository garantit l'unicité et l'atomicité des associations en persistance.
type TagRepository interface {
	// List retourne tous les tags, même inutilisés, par ID croissant.
	List(context.Context) ([]Tag, error)
	// Add vérifie la vidéo et crée tags et associations dans une opération atomique.
	// Les noms sont validés ; le résultat contient tous les tags associés par ID croissant.
	Add(context.Context, VideoID, []TagName) ([]Tag, error)
	// Remove vérifie la vidéo puis retire seulement l'association, même déjà absente.
	Remove(context.Context, VideoID, TagID) error
}

// TagService porte les opérations locales de classement des vidéos.
type TagService struct{ repository TagRepository }

// NewTagService assemble le port de persistance des tags.
func NewTagService(repository TagRepository) *TagService { return &TagService{repository: repository} }

// List retourne le catalogue, y compris les tags inutilisés.
func (s *TagService) List(ctx context.Context) ([]Tag, error) { return s.repository.List(ctx) }

// Add valide tout le lot avant écriture ; un lot vide est refusé.
func (s *TagService) Add(ctx context.Context, id VideoID, names []string) ([]Tag, error) {
	if id <= 0 || len(names) == 0 {
		return nil, ErrInvalidInput
	}
	normalized := make([]TagName, 0, len(names))
	seen := make(map[string]bool)
	for _, name := range names {
		value, err := NormalizeTagName(name)
		if err != nil {
			return nil, err
		}
		// Le premier nom du lot fournit l'affichage si le tag n'existe pas encore.
		if !seen[value.Key] {
			normalized = append(normalized, value)
			seen[value.Key] = true
		}
	}
	return s.repository.Add(ctx, id, normalized)
}

// Remove est idempotent pour une vidéo existante, sans supprimer le tag partagé.
func (s *TagService) Remove(ctx context.Context, id VideoID, tagID TagID) error {
	if id <= 0 || tagID <= 0 {
		return ErrInvalidInput
	}
	return s.repository.Remove(ctx, id, tagID)
}
