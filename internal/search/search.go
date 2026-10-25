// Package search expose la recherche sans dépendance au transport ou au moteur.
package search

import (
	"context"
	"errors"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// Ces bornes limitent le travail du moteur et la pagination publique.
const (
	PageSize      = 20
	MaxPage       = 1000
	MaxQueryBytes = 1024
	MaxTerms      = 32
)

// Sort définit le classement des vidéos indépendamment du moteur et du transport.
type Sort string

const (
	// SortRelevance classe par pertinence puis par identité croissante.
	SortRelevance Sort = "relevance"
	// SortNewest classe par date d'ajout puis par identité décroissantes.
	SortNewest Sort = "newest"
)

// ErrInvalidInput indique une saisie, un tri ou une pagination hors contrat.
var ErrInvalidInput = errors.New("invalid search input")

// Segment est affiché littéralement, jamais comme HTML.
type Segment struct {
	Text      string `json:"text"`
	Highlight bool   `json:"highlight"`
}

// SourceMatch identifie les champs contributeurs sans attribuer toute la requête à une source.
type SourceMatch struct {
	SourceID    video.VideoSourceID `json:"source_id"`
	Title       bool                `json:"title"`
	Description bool                `json:"description"`
	Publisher   bool                `json:"publisher"`
}

// Result conserve l'identité vidéo et ses explications.
type Result struct {
	Video       video.Video
	NoteExcerpt []Segment
	Sources     []SourceMatch
}

// Page reflète la bibliothèque courante, sans instantané entre appels.
type Page struct {
	Results []Result
	HasMore bool
	// Total compte les vidéos correspondantes dans le même instantané que Results.
	Total int64
}

// Repository reçoit un tri résolu, sans syntaxe ni score moteur publics.
type Repository interface {
	Search(context.Context, string, int, Sort) (Page, error)
}

// Service porte les validations communes à REST et aux futures interfaces MCP.
type Service struct{ repository Repository }

// NewService utilise la projection de l'adapter.
func NewService(repository Repository) *Service { return &Service{repository: repository} }

// Search recherche tous les termes et utilise la pertinence si le tri est absent.
func (s *Service) Search(ctx context.Context, query string, page int, sort Sort) (Page, error) {
	if !utf8.ValidString(query) || len(query) > MaxQueryBytes || page < 1 || page > MaxPage {
		return Page{}, ErrInvalidInput
	}
	if sort == "" {
		sort = SortRelevance
	}
	if sort != SortRelevance && sort != SortNewest {
		return Page{}, ErrInvalidInput
	}
	return s.repository.Search(ctx, query, page, sort)
}
