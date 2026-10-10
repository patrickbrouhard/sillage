package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

var channelIDPattern = regexp.MustCompile(`^UC[A-Za-z0-9_-]{22}$`)

// publisher ne déduit jamais une identité d'un handle ou d'un nom affiché.
func (m metadata) publisher() *video.Publisher {
	id := strings.TrimSpace(m.ChannelID)
	if !channelIDPattern.MatchString(id) {
		return nil
	}
	name := strings.TrimSpace(m.Channel)
	if name == "" {
		name = strings.TrimSpace(m.Uploader)
	}
	return &video.Publisher{Provider: "youtube", ExternalID: id, Name: name}
}

// ResolvePublisher identifie une chaîne sans télécharger ses vidéos ni parcourir tout son catalogue.
func (c Client) ResolvePublisher(ctx context.Context, input string) (video.Publisher, error) {
	u, err := url.Parse(strings.TrimSpace(input))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Port() != "" && u.Port() != "443" && u.Port() != "80") {
		return video.Publisher{}, video.ErrInvalidInput
	}
	switch strings.ToLower(u.Hostname()) {
	case "youtube.com", "www.youtube.com", "m.youtube.com":
	default:
		return video.Publisher{}, video.ErrInvalidInput
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	base := 0
	if len(parts) > 0 && strings.HasPrefix(parts[0], "@") && len(parts[0]) > 1 {
		base = 1
	} else if len(parts) >= 2 && parts[1] != "" && (parts[0] == "channel" || parts[0] == "user" || parts[0] == "c") {
		base = 2
		if parts[0] == "channel" && !channelIDPattern.MatchString(parts[1]) {
			return video.Publisher{}, video.ErrInvalidInput
		}
	}
	if base == 0 || len(parts) > base+1 {
		return video.Publisher{}, video.ErrInvalidInput
	}
	if len(parts) == base+1 {
		switch parts[base] {
		case "videos", "shorts", "streams", "featured", "about":
		default:
			return video.Publisher{}, video.ErrInvalidInput
		}
	}
	// Normaliser vers la racine du compte exclut les URL de vidéo ou de playlist.
	u = &url.URL{Scheme: "https", Host: "www.youtube.com", Path: "/" + strings.Join(parts[:base], "/")}
	binary := c.Binary
	if binary == "" {
		binary = "yt-dlp"
	}
	cmd := exec.CommandContext(ctx, binary, "--ignore-config", "--dump-single-json", "--simulate", "--flat-playlist", "--playlist-items", "0", "--no-progress", "--", u.String())
	cmd.WaitDelay = 2 * time.Second
	output := &boundedOutput{limit: 4 << 20}
	stderr := &boundedOutput{limit: 16 << 10}
	cmd.Stdout = output
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return video.Publisher{}, ctx.Err()
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return video.Publisher{}, fmt.Errorf("%w: %w", video.ErrMetadataProviderUnavailable, err)
		}
		return video.Publisher{}, fmt.Errorf("%w: %w: %s", video.ErrMetadataFetchFailed, err, stderr.buffer.String())
	}
	if output.truncated {
		return video.Publisher{}, fmt.Errorf("%w: publisher metadata exceeds 4 MiB", video.ErrMetadataFetchFailed)
	}
	return parsePublisher(output.buffer.Bytes())
}

// parsePublisher exige les métadonnées du compte lui-même, pas celles d'une entrée vidéo.
func parsePublisher(data []byte) (video.Publisher, error) {
	var raw metadata
	if err := json.Unmarshal(data, &raw); err != nil {
		return video.Publisher{}, fmt.Errorf("%w: %v", video.ErrMetadataFetchFailed, err)
	}
	if raw.Type != "playlist" || raw.ExtractorKey != "YoutubeTab" {
		return video.Publisher{}, video.ErrMetadataFetchFailed
	}
	p := raw.publisher()
	if p == nil {
		return video.Publisher{}, video.ErrMetadataFetchFailed
	}
	return *p, nil
}
