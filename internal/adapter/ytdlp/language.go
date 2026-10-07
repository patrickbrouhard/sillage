package ytdlp

import (
	"regexp"
	"strings"
)

var languageTag = regexp.MustCompile(`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`)

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
// À défaut de signal audio explicite, une seule clé -orig constitue un indice fiable.
func (m metadata) originalLanguage() (string, bool) {
	languages := make(map[string]bool)
	for _, format := range m.Formats {
		if format.Preference == 10 && format.Codec != "" && format.Codec != "none" && usableLanguage(format.Language) {
			languages[format.Language] = true
		}
	}
	if len(languages) > 1 {
		return "", true
	}
	for language := range languages {
		return language, false
	}
	for track, formats := range m.AutomaticCaptions {
		language, ok := strings.CutSuffix(track, "-orig")
		if ok && usableLanguage(language) && len(formats) > 0 {
			languages[language] = true
		}
	}
	if len(languages) == 1 {
		for language := range languages {
			return language, false
		}
	}
	return "", false
}
