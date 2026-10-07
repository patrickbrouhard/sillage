package transcript

import "errors"

// ErrNotFound indique qu'aucune acquisition de la politique actuelle n'existe.
var ErrNotFound = errors.New("transcript not found")

// ErrNotAvailable indique qu'aucune piste originale ne peut être choisie de façon fiable.
var ErrNotAvailable = errors.New("transcript not available")

// ErrFetchFailed indique un échec distant ou un contenu distant inexploitable.
var ErrFetchFailed = errors.New("transcript fetch failed")
