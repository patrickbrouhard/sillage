package video

import "errors"

// ErrInvalidInput indique que l'entrée ne peut pas être traitée par le cas d'usage.
var ErrInvalidInput = errors.New("invalid input")

// ErrMetadataFetchFailed indique que le fournisseur n'a pas fourni de métadonnées exploitables.
var ErrMetadataFetchFailed = errors.New("metadata fetch failed")

// ErrMetadataProviderUnavailable indique un problème local empêchant l'exécution du fournisseur.
var ErrMetadataProviderUnavailable = errors.New("metadata provider unavailable")
