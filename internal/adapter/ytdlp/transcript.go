package ytdlp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

const maxTranscriptBytes = 16 << 20

// Fetch découvre une piste originale unique, télécharge son JSON3 et valide tout le contenu.
func (c Client) Fetch(ctx context.Context, source video.VideoSource) (transcript.Acquisition, error) {
	if source.Provider != "youtube" || source.ExternalID == "" {
		return transcript.Acquisition{}, transcript.ErrNotAvailable
	}
	// Reconstruire l'URL depuis l'identité évite de dépendre d'un localisateur arbitraire.
	sourceURL := "https://www.youtube.com/watch?v=" + url.QueryEscape(source.ExternalID)
	data, err := c.transcriptCommand(ctx, "--dump-single-json", "--simulate", "--", sourceURL)
	if err != nil {
		return transcript.Acquisition{}, err
	}
	normalized, err := parseMetadata(data)
	if err != nil || normalized.ExternalID != source.ExternalID {
		return transcript.Acquisition{}, fmt.Errorf("%w: inconsistent discovery metadata: %v", transcript.ErrFetchFailed, err)
	}
	var raw metadata
	if err := json.Unmarshal(data, &raw); err != nil {
		return transcript.Acquisition{}, fmt.Errorf("%w: %v", transcript.ErrFetchFailed, err)
	}
	track, language, err := selectOriginal(raw, source.OriginalAudioLanguage)
	if err != nil {
		return transcript.Acquisition{}, err
	}
	dir, err := os.MkdirTemp("", "sillage-captions-")
	if err != nil {
		return transcript.Acquisition{}, fmt.Errorf("create captions directory: %w", err)
	}
	defer os.RemoveAll(dir)
	info := filepath.Join(dir, "source.json")
	if err := os.WriteFile(info, data, 0600); err != nil {
		return transcript.Acquisition{}, fmt.Errorf("write discovery metadata: %w", err)
	}
	// La seconde commande réutilise exactement la découverte : pas de nouvelle
	// sélection distante entre le choix de langue et le téléchargement.
	_, err = c.transcriptCommand(ctx,
		"--load-info-json", info,
		"--no-simulate", "--skip-download",
		"--write-auto-subs", "--no-write-subs",
		"--sub-langs", "^"+regexp.QuoteMeta(track)+"$",
		"--sub-format", "json3",
		"--output", filepath.Join(dir, "caption.%(ext)s"),
	)
	if err != nil {
		return transcript.Acquisition{}, err
	}
	path := filepath.Join(dir, "caption."+track+".json3")
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return transcript.Acquisition{}, fmt.Errorf("%w: no downloaded caption", transcript.ErrFetchFailed)
		}
		return transcript.Acquisition{}, fmt.Errorf("open downloaded caption: %w", err)
	}
	defer file.Close()
	data, err = io.ReadAll(io.LimitReader(file, maxTranscriptBytes+1))
	if err != nil {
		return transcript.Acquisition{}, fmt.Errorf("read downloaded caption: %w", err)
	}
	if len(data) > maxTranscriptBytes {
		return transcript.Acquisition{}, fmt.Errorf("%w: caption exceeds 16 MiB", transcript.ErrFetchFailed)
	}
	if err := ctx.Err(); err != nil {
		return transcript.Acquisition{}, err
	}
	content, err := ParseJSON3(data)
	if err != nil {
		return transcript.Acquisition{}, fmt.Errorf("%w: %v", transcript.ErrFetchFailed, err)
	}
	if err := ctx.Err(); err != nil {
		return transcript.Acquisition{}, err
	}
	return transcript.Acquisition{Language: language, Content: content, Source: data}, nil
}

// selectOriginal compte les clés logiques admissibles, et non leurs formats ou URLs.
func selectOriginal(raw metadata, knownLanguage string) (string, string, error) {
	detected, conflict := raw.originalLanguage()
	if conflict {
		return "", "", transcript.ErrNotAvailable
	}
	if knownLanguage != "" && detected != "" && knownLanguage != detected {
		return "", "", transcript.ErrNotAvailable
	}
	language := knownLanguage
	if language == "" {
		language = detected
	}
	candidates := make(map[string]string)
	for track, formats := range raw.AutomaticCaptions {
		lang, ok := strings.CutSuffix(track, "-orig")
		if !ok || !usableLanguage(lang) || (language != "" && lang != language) {
			continue
		}
		for _, format := range formats {
			u, err := url.Parse(format.URL)
			if format.Extension == "json3" && err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil {
				candidates[track] = lang
			}
		}
	}
	if len(candidates) != 1 {
		return "", "", transcript.ErrNotAvailable
	}
	for track, lang := range candidates {
		return track, lang, nil
	}
	panic("unreachable")
}

// transcriptCommand classe les échecs sans interpréter stderr et borne les sorties en mémoire.
func (c Client) transcriptCommand(ctx context.Context, args ...string) ([]byte, error) {
	binary := c.Binary
	if binary == "" {
		binary = "yt-dlp"
	}
	args = append([]string{"--ignore-config", "--no-playlist", "--no-progress", "--no-cache-dir"}, args...)
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.WaitDelay = time.Second
	stdout := &boundedOutput{limit: 64 << 20}
	stderr := &boundedOutput{limit: 16 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			return nil, fmt.Errorf("%w: yt-dlp: %w: %s", transcript.ErrFetchFailed, err, stderr.buffer.String())
		}
		return nil, fmt.Errorf("execute yt-dlp: %w", err)
	}
	if stdout.truncated {
		return nil, fmt.Errorf("%w: oversized discovery", transcript.ErrFetchFailed)
	}
	return stdout.buffer.Bytes(), nil
}

// boundedOutput continue de drainer les pipes après la limite pour ne pas bloquer le processus.
type boundedOutput struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (b *boundedOutput) Write(data []byte) (int, error) {
	size := len(data)
	remaining := b.limit - b.buffer.Len()
	if len(data) > remaining {
		data = data[:remaining]
		b.truncated = true
	}
	_, _ = b.buffer.Write(data)
	return size, nil
}
