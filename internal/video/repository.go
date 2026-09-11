package video

import (
	"context"
	"errors"
)

// ErrVideoNotFound indique qu'aucune vidéo ne correspond à la recherche.
var ErrVideoNotFound = errors.New("video not found")

// ErrSourceAlreadyExists indique qu'une identité externe appartient déjà à une source.
var ErrSourceAlreadyExists = errors.New("source already exists")

// VideoRepository persiste et relit des vidéos avec toutes leurs sources.
type VideoRepository interface {
	// Create attribue les identités et crée atomiquement la vidéo et ses sources.
	// La vidéo doit être nouvelle, datée et posséder au moins une source.
	// Un doublon d’identité externe retourne ErrSourceAlreadyExists, sans création partielle.
	Create(ctx context.Context, v Video) (Video, error)
	// Get retourne la vidéo ou une erreur enveloppant ErrVideoNotFound.
	Get(ctx context.Context, id VideoID) (Video, error)
	// List retourne toute la bibliothèque par date de création puis ID décroissants.
	// Les sources de chaque vidéo sont ordonnées par ID croissant.
	List(ctx context.Context) ([]Video, error)
	// FindBySource recherche une identité externe non vide.
	FindBySource(ctx context.Context, provider, externalID string) (Video, error)
}
