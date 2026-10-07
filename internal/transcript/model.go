// Package transcript définit les transcriptions acquises et leur contenu temporel.
package transcript

import (
	"strings"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// YouTubeAuto désigne une transcription automatique originale fournie par YouTube.
const YouTubeAuto = "youtube_auto"

// TranscriptID identifie une transcription indépendamment de son snapshot.
type TranscriptID int64

// Transcript décrit une acquisition réussie ; LocalPath vide signifie absence de snapshot.
type Transcript struct {
	ID            TranscriptID
	VideoSourceID video.VideoSourceID
	Language      string
	Provenance    string
	LocalPath     string
	LastFetchedAt time.Time
}

// TranscriptItem associe un fragment textuel, espaces compris, à sa position média.
type TranscriptItem struct {
	StartMS int64
	Text    string
}

// TranscriptContent conserve l'ordre textuel des fragments, y compris à temps égal.
type TranscriptContent []TranscriptItem

// PlainText concatène les fragments puis normalise les blancs sans ajouter de ponctuation.
func (c TranscriptContent) PlainText() string {
	var text strings.Builder
	for _, item := range c {
		text.WriteString(item.Text)
	}
	return strings.Join(strings.Fields(text.String()), " ")
}

// Result rassemble l'identité acquise et son contenu indépendant du format source.
type Result struct {
	Transcript Transcript
	Content    TranscriptContent
}
