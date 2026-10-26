package mcp

import (
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"unicode"
	"unicode/utf8"
)

// minimumFragmentBytes compte seulement les champs indispensables dans les deux canaux.
const minimumFragmentBytes = 2 * len(`{"start_ms":0,"text":""}`)

// textBudget est une borne inférieure de la taille des deux canaux JSON.
// Il ne sérialise rien : certaines clés, métadonnées et échappements restent exclus.
type textBudget struct {
	bytes int
	limit int
}

// add compte les corps de chaînes avec les échappements garantis par encoding/json.
// Arrêter dès le seuil franchi borne le travail sur les contenus déjà inadmissibles.
func (b *textBudget) add(text string) {
	for len(text) > 0 && b.bytes <= b.limit {
		r, n := utf8.DecodeRuneInString(text)
		size := n
		switch {
		case r == '"' || r == '\\' || r == '\b' || r == '\f' || r == '\n' || r == '\r' || r == '\t':
			size = 2
		case r < 0x20 || r == '<' || r == '>' || r == '&' || r == '\u2028' || r == '\u2029' || (r == utf8.RuneError && n == 1):
			size = 6
		}
		b.bytes += 2 * size
		text = text[n:]
	}
}

func (b *textBudget) source(source sourceDTO) {
	b.bytes += 2 * len(`{"id":0,"provider":"","external_id":"","title":"","publisher":0,"duration_ms":0,"original_audio_language":""}`)
	for _, text := range []string{source.Provider, source.ExternalID, source.CanonicalURL, source.Title, source.OriginalAudioLanguage} {
		b.add(text)
	}
	if p := source.Publisher; p != nil {
		b.add(p.Provider)
		b.add(p.ExternalID)
		b.add(p.Name)
	}
}

func (b *textBudget) tags(tags []tagDTO) {
	b.bytes += 2 * len(tags) * len(`{"id":0,"name":""}`)
	for _, tag := range tags {
		b.add(tag.Name)
		if b.bytes > b.limit {
			break
		}
	}
}

// payloadLowerBound inspecte uniquement les quatre DTO de l'adapter.
// Ce prévol refuse tôt les textes échappés et les grandes listes timed ; il ne
// prétend ni calculer la taille finale exacte, ni borner le stockage déjà chargé.
func payloadLowerBound(value any, limit int) int {
	budget := textBudget{limit: limit}
	switch out := value.(type) {
	case noteDTO:
		budget.add(out.ContentMD)
	case transcriptDTO:
		budget.add(out.Language)
		budget.add(out.Provenance)
		if out.Text != nil {
			budget.add(*out.Text)
		}
		if out.Fragments != nil {
			// Chaque fragment comporte au moins ces clés et une position à un chiffre.
			budget.bytes += len(*out.Fragments) * minimumFragmentBytes
			for _, fragment := range *out.Fragments {
				budget.add(fragment.Text)
				if budget.bytes > limit {
					break
				}
			}
		}
	case videoDTO:
		budget.bytes += 2 * len(out.PersonIDs)
		budget.tags(out.Tags)
		for _, source := range out.Sources {
			budget.source(source.sourceDTO)
			budget.add(source.Description)
			if budget.bytes > limit {
				break
			}
		}
	case searchDTO:
		for _, result := range out.Results {
			budget.tags(result.Video.Tags)
			for _, source := range result.Video.Sources {
				budget.source(source)
			}
			for _, segment := range result.NoteExcerpt {
				budget.add(segment.Text)
			}
			if budget.bytes > limit {
				break
			}
		}
	}
	return budget.bytes
}

// transcriptTextLowerBound compte seulement les caractères ASCII non blancs conservés
// par PlainText. Ignorer Unicode et les séparateurs reste conservateur, même si deux
// fragments joignent des octets UTF-8 ; aucune normalisation du contenu n'est produite.
func transcriptTextLowerBound(content transcript.TranscriptContent, limit int) int {
	budget := textBudget{limit: limit}
	for _, fragment := range content {
		for i := 0; i < len(fragment.Text) && budget.bytes <= limit; i++ {
			c := fragment.Text[i]
			if c < utf8.RuneSelf && !unicode.IsSpace(rune(c)) {
				budget.add(fragment.Text[i : i+1])
			}
		}
		if budget.bytes > limit {
			break
		}
	}
	return budget.bytes
}

// oversizedResultError transporte seulement la borne de taille calculée avant PlainText.
type oversizedResultError struct{ lowerBound int }

// Error n'expose aucune donnée lue ; register traduit cette cause en erreur d'outil.
func (e *oversizedResultError) Error() string { return "local tool result exceeds size limit" }
