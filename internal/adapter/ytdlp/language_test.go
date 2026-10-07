package ytdlp

import (
	"encoding/json"
	"errors"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"testing"
)

func TestOriginalLanguageAndSelection(t *testing.T) {
	const en = `"en-orig":[{"ext":"vtt","url":"https://example.test/vtt"},{"ext":"json3","url":"https://example.test/en"},{"ext":"json3","url":"https://example.test/en2"}]`
	const fr = `"fr-orig":[{"ext":"json3","url":"https://example.test/fr"}]`
	for _, tc := range []struct{ name, fields, known, want, inferred string }{
		{"unique caption", `"automatic_captions":{` + en + `}`, "", "en", "en"},
		{"known disambiguates", `"automatic_captions":{` + en + "," + fr + `}`, "fr", "fr", ""},
		{"ambiguous", `"automatic_captions":{` + en + "," + fr + `}`, "", "", ""},
		{"audio disambiguates", `"formats":[{"language":"en","language_preference":10,"acodec":"opus"},{"language":"en","language_preference":10,"acodec":"aac"}],"automatic_captions":{` + en + "," + fr + `}`, "", "en", "en"},
		{"default is not original", `"formats":[{"language":"en","language_preference":5,"acodec":"opus"}],"automatic_captions":{` + en + "," + fr + `}`, "", "", ""},
		{"video language ignored", `"formats":[{"language":"en","language_preference":10,"acodec":"none"}],"automatic_captions":{` + en + "," + fr + `}`, "", "", ""},
		{"conflicting audio", `"formats":[{"language":"en","language_preference":10,"acodec":"opus"},{"language":"fr","language_preference":10,"acodec":"opus"}],"automatic_captions":{` + en + `}`, "", "", ""},
		{"known mismatch", `"automatic_captions":{` + en + `}`, "fr", "", "en"},
		{"regional", `"automatic_captions":{"pt-BR-orig":[{"ext":"json3","url":"https://example.test/br"}]}`, "", "pt-BR", "pt-BR"},
		{"no original", `"automatic_captions":{"en":[{"ext":"json3","url":"https://example.test/en"}]}`, "", "", ""},
		{"no json3", `"automatic_captions":{"en-orig":[{"ext":"vtt","url":"https://example.test/en"}]}`, "", "", "en"},
		{"manual only", `"subtitles":{` + en + `}`, "", "", ""},
		{"undetermined", `"automatic_captions":{"und-orig":[{"ext":"json3","url":"https://example.test/en"}]}`, "", "", ""},
		{"missing captions", `"language":"en"`, "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := []byte(`{"extractor_key":"Youtube","id":"abc","title":"Titre",` + tc.fields + "}")
			var raw metadata
			if err := json.Unmarshal(data, &raw); err != nil {
				t.Fatal(err)
			}
			source, err := parseMetadata(data)
			if err != nil || source.OriginalAudioLanguage != tc.inferred {
				t.Fatalf("%#v %v", source, err)
			}
			track, lang, err := selectOriginal(raw, tc.known)
			if tc.want == "" {
				if !errors.Is(err, transcript.ErrNotAvailable) {
					t.Fatalf("%s %s %v", track, lang, err)
				}
			} else if err != nil || lang != tc.want || track != tc.want+"-orig" {
				t.Fatalf("%s %s %v", track, lang, err)
			}
		})
	}
}
