package transcript

import "errors"

// ErrNotFound indique qu'aucune acquisition de la politique actuelle n'existe.
var ErrNotFound = errors.New("transcript not found")

// ErrNotAvailable indique qu'aucune piste automatique originale n'est admissible.
var ErrNotAvailable = errors.New("transcript not available")

// ErrSelectionAmbiguous indique plusieurs pistes admissibles sans priorité exacte.
var ErrSelectionAmbiguous = errors.New("transcript selection ambiguous")

// ErrFetchFailed indique un échec distant ou un contenu distant inexploitable.
var ErrFetchFailed = errors.New("transcript fetch failed")
