// Package ytdlp extrait et normalise les métadonnées via le binaire externe yt-dlp.
package ytdlp

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// Client interroge yt-dlp sans télécharger le média.
// Sa valeur zéro utilise le binaire yt-dlp trouvé dans le PATH.
type Client struct {
	// Binary permet de préciser le chemin d'un binaire existant.
	Binary string
}

// Extract récupère les métadonnées d'une vidéo YouTube unique.
// Le contexte permet d'annuler l'exécution ; aucun JSON brut n'est conservé.
func (c Client) Extract(ctx context.Context, inputURL string) (video.VideoSource, error) {
	inputURL = strings.TrimSpace(inputURL)
	u, err := url.Parse(inputURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return video.VideoSource{}, fmt.Errorf("expected a YouTube HTTP(S) URL")
	}

	switch strings.ToLower(u.Hostname()) {
	case "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be":
	default:
		return video.VideoSource{}, fmt.Errorf("unsupported YouTube host %q", u.Hostname())
	}

	binary := c.Binary
	if binary == "" {
		binary = "yt-dlp"
	}
	// Ignorer la configuration locale garantit une sortie JSON et aucun téléchargement.
	cmd := exec.CommandContext(ctx, binary,
		"--ignore-config", "--dump-single-json", "--simulate", "--no-playlist",
		"--no-progress", "--", inputURL)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return video.VideoSource{}, fmt.Errorf("extract video metadata: %w", ctx.Err())
		}
		return video.VideoSource{}, fmt.Errorf("execute yt-dlp: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return parseMetadata(data)
}
