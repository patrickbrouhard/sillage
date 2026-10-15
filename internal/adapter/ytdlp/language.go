package ytdlp

import "regexp"

// originalAudioPreference est le signal original de l’extracteur YouTube, distinct du défaut (5).
const originalAudioPreference = 10

var languageTag = regexp.MustCompile(`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`)

// simpleRegionalLanguage exclut écritures, variantes et extensions : seule une
// région de deux lettres ou trois chiffres peut céder à la langue générique.
var simpleRegionalLanguage = regexp.MustCompile(`^([A-Za-z]{2,8})-(?:[A-Za-z]{2}|[0-9]{3})$`)

// usableLanguage écarte les marqueurs indéterminés sans tronquer les sous-étiquettes.
func usableLanguage(language string) bool {
	return languageTag.MatchString(language) && language != "und" && language != "mul" && language != "zxx"
}

type audioFormat struct {
	Language   string `json:"language"`
	Preference int    `json:"language_preference"`
	Codec      string `json:"acodec"`
}

type captionFormat struct {
	Extension string `json:"ext"`
	URL       string `json:"url"`
}

// originalLanguage utilise le signal original de yt-dlp (10), jamais default (5).
// Voir yt_dlp/extractor/youtube/_video.py, get_language_code_and_preference.
// Les captions ne permettent jamais d'inférer la langue audio.
func (m metadata) originalLanguage() (string, bool) {
	languages := make(map[string]bool)
	for _, format := range m.Formats {
		if format.Preference == originalAudioPreference && format.Codec != "" && format.Codec != "none" && usableLanguage(format.Language) {
			languages[format.Language] = true
		}
	}
	if len(languages) > 1 {
		return "", true
	}
	for language := range languages {
		return language, false
	}
	return "", false
}
