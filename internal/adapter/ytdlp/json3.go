package ytdlp

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/transcript"
)

// json3Document isole les champs utiles ; les événements de présentation sont ignorés.
type json3Document struct {
	Events []struct {
		Start    *int64 `json:"tStartMs"`
		Append   int    `json:"aAppend"`
		Segments []struct {
			Offset *int64 `json:"tOffsetMs"`
			Text   string `json:"utf8"`
		} `json:"segs"`
	} `json:"events"`
}

// ParseJSON3 valide un document complet et préserve l'ordre et les blancs des fragments.
func ParseJSON3(data []byte) (transcript.TranscriptContent, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid UTF-8 transcript")
	}
	var doc json3Document
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parse JSON3: %w", err)
	}
	items := make(transcript.TranscriptContent, 0)
	for _, event := range doc.Events {
		hasText := false
		for _, seg := range event.Segments {
			hasText = hasText || seg.Text != ""
		}
		if !hasText {
			continue
		}
		if event.Start == nil || *event.Start < 0 {
			return nil, fmt.Errorf("missing or negative event time")
		}
		first := true
		for _, seg := range event.Segments {
			offset := int64(0)
			if seg.Offset != nil {
				offset = *seg.Offset
			}
			if offset < 0 || offset > math.MaxInt64-*event.Start {
				return nil, fmt.Errorf("invalid segment offset")
			}
			if seg.Text == "" {
				continue
			}
			text := seg.Text
			// Deux événements autonomes représentent deux blocs. Insérer leur séparation
			// dans les items permet de reconstruire le texte sans consulter le JSON3.
			// Un événement aAppend prolonge en revanche le bloc précédent tel quel.
			if first && event.Append == 0 && len(items) > 0 {
				last, _ := utf8.DecodeLastRuneInString(items[len(items)-1].Text)
				next, _ := utf8.DecodeRuneInString(text)
				if !unicode.IsSpace(last) && !unicode.IsSpace(next) {
					text = "\n" + text
				}
			}
			items = append(items, transcript.TranscriptItem{StartMS: *event.Start + offset, Text: text})
			first = false
		}
	}
	// Un JSON valide sans texte ne constitue pas une acquisition exploitable.
	if len(items) == 0 || strings.TrimSpace(items.PlainText()) == "" {
		return nil, fmt.Errorf("JSON3 contains no usable text")
	}
	return items, nil
}
