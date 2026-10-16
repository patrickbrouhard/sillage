package ytdlp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// MediaClient acquiert un média fini et le valide avec ffprobe, sans publication.
type MediaClient struct {
	Binary      string
	ProbeBinary string
}

type mediaFormat struct {
	ID                 string  `json:"format_id"`
	Extension          string  `json:"ext"`
	VideoCodec         string  `json:"vcodec"`
	AudioCodec         string  `json:"acodec"`
	Width              int     `json:"width"`
	Height             int     `json:"height"`
	FPS                float64 `json:"fps"`
	Language           string  `json:"language"`
	LanguagePreference int     `json:"language_preference"`
	URL                string  `json:"url"`
}

type mediaDiscovery struct {
	ID         string        `json:"id"`
	Extractor  string        `json:"extractor_key"`
	Type       string        `json:"_type"`
	Duration   float64       `json:"duration"`
	LiveStatus string        `json:"live_status"`
	IsLive     bool          `json:"is_live"`
	Formats    []mediaFormat `json:"formats"`
}

// filterMediaAudio ne classe aucun format : il restreint seulement l'identité audio.
// Les variantes techniques restent à départager par le sélecteur natif de yt-dlp.
func filterMediaAudio(data []byte, d mediaDiscovery, knownLanguage string) ([]byte, error) {
	languages := make(map[string]bool)
	originals := make(map[string]bool)
	for _, f := range d.Formats {
		if f.AudioCodec == "" || f.AudioCodec == "none" || f.LanguagePreference < -1 {
			continue
		}
		languages[f.Language] = true
		if f.LanguagePreference == originalAudioPreference && usableLanguage(f.Language) {
			originals[f.Language] = true
		}
	}
	language := ""
	requireOriginal := false
	switch {
	case len(originals) > 1:
		return nil, media.ErrAudio
	case len(originals) == 1:
		requireOriginal = true
		for value := range originals {
			language = value
		}
	case knownLanguage != "":
		// L'original connu absent n'autorise pas le repli vers une langue disponible différente.
		if !languages[knownLanguage] {
			return nil, media.ErrSelection
		}
		language = knownLanguage
	case len(languages) == 1:
		for value := range languages {
			language = value
		}
	case len(languages) == 0:
		return nil, media.ErrSelection
	default:
		return nil, media.ErrAudio
	}
	// Sans signal original, des rôles audio différents dans une même langue
	// ne sont pas de simples variantes de codec : le défaut ne prouve pas l’originalité.
	roles := make(map[int]bool)
	if !requireOriginal {
		for _, f := range d.Formats {
			if f.AudioCodec != "" && f.AudioCodec != "none" && f.Language == language && f.LanguagePreference >= -1 {
				roles[f.LanguagePreference] = true
			}
		}
		if len(roles) > 1 {
			return nil, media.ErrAudio
		}
	}
	allowedAudio := func(f mediaFormat) bool {
		return f.AudioCodec == "none" || (f.AudioCodec != "" && f.Language == language &&
			f.LanguagePreference >= -1 && (!requireOriginal || f.LanguagePreference == originalAudioPreference))
	}
	// Préserver les champs inconnus de yt-dlp (manifestes, fragments, en-têtes).
	// Les formats combinés non admissibles sont retirés eux aussi.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, media.ErrInvalid
	}
	var formats []json.RawMessage
	if err := json.Unmarshal(raw["formats"], &formats); err != nil {
		return nil, media.ErrInvalid
	}
	filtered := make([]json.RawMessage, 0, len(formats))
	for _, item := range formats {
		var f mediaFormat
		if err := json.Unmarshal(item, &f); err != nil {
			return nil, media.ErrInvalid
		}
		if allowedAudio(f) {
			filtered = append(filtered, item)
		}
	}
	raw["formats"], _ = json.Marshal(filtered)
	// La sélection précédente de la découverte ne doit pas survivre au filtre métier.
	delete(raw, "requested_formats")
	delete(raw, "requested_downloads")
	// download_with_info_file réextrait sinon l’URL après erreur, ce qui perdrait notre filtre.
	delete(raw, "webpage_url")
	delete(raw, "original_url")
	delete(raw, "url")
	raw["_type"] = json.RawMessage(`"video"`)
	return json.Marshal(raw)
}

// Download filtre l’identité audio puis laisse yt-dlp choisir et assembler les formats.
func (c MediaClient) Download(ctx context.Context, source video.VideoSource, stage string) (media.Acquired, error) {
	// yt-dlp expose un chemin absolu après déplacement, même avec une sortie relative.
	// Comparer deux chemins absolus préserve le contrôle de confinement en production.
	stage, err := filepath.Abs(stage)
	if err != nil {
		return media.Acquired{}, err
	}

	if source.Provider != "youtube" || !regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`).MatchString(source.ExternalID) {
		return media.Acquired{}, media.ErrUnsupported
	}
	binary := c.Binary
	if binary == "" {
		binary = "yt-dlp"
	}
	common := []string{"--ignore-config", "--no-playlist", "--no-progress", "--no-cache-dir", "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3"}
	args := append(append([]string{}, common...), "--dump-single-json", "--simulate", "-S", "res:1080", "--", "https://www.youtube.com/watch?v="+source.ExternalID)
	data, err := mediaCommand(ctx, binary, args...)
	if err != nil {
		return media.Acquired{}, err
	}
	var discovery mediaDiscovery
	if err := json.Unmarshal(data, &discovery); err != nil {
		return media.Acquired{}, media.ErrInvalid
	}
	if discovery.ID != source.ExternalID || discovery.Extractor != "Youtube" || (discovery.Type != "" && discovery.Type != "video") {
		return media.Acquired{}, media.ErrInvalid
	}
	if discovery.IsLive || (discovery.LiveStatus != "not_live" && discovery.LiveStatus != "was_live") || discovery.Duration <= 0 {
		return media.Acquired{}, media.ErrUnfinished
	}
	data, err = filterMediaAudio(data, discovery, source.OriginalAudioLanguage)
	if err != nil {
		return media.Acquired{}, err
	}
	info := filepath.Join(stage, "source.json")
	if err := os.WriteFile(info, data, 0600); err != nil {
		return media.Acquired{}, err
	}
	args = append(append([]string{}, common...),
		"--load-info-json", info, "--no-simulate", "--no-continue",
		"--abort-on-unavailable-fragments", "--no-keep-video",
		"--no-audio-multistreams", "--no-video-multistreams",
		"--format", "bv*+ba/b", "-S", "res:1080",
		"--print", "after_move:%(filepath)j",
		"--output", filepath.Join(stage, "media.%(ext)s"))
	output, err := mediaCommand(ctx, binary, args...)
	if err != nil {
		return media.Acquired{}, err
	}
	var path string
	if err := json.Unmarshal(bytes.TrimSpace(output), &path); err != nil {
		return media.Acquired{}, media.ErrInvalid
	}
	// Ne jamais publier un chemin extérieur ou un nom dérivé d'un titre distant.
	container := strings.TrimPrefix(filepath.Ext(path), ".")
	if filepath.Clean(filepath.Dir(path)) != filepath.Clean(stage) ||
		filepath.Base(path) != "media."+container ||
		!regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`).MatchString(container) {
		return media.Acquired{}, media.ErrInvalid
	}

	probe := c.ProbeBinary
	if probe == "" {
		probe = "ffprobe"
	}
	data, err = mediaCommand(ctx, probe, "-v", "error", "-show_format", "-show_streams", "-of", "json", path)
	if err != nil {
		if ctx.Err() != nil {
			return media.Acquired{}, ctx.Err()
		}
		return media.Acquired{}, fmt.Errorf("%w: probe: %v", media.ErrInvalid, err)
	}
	return validateProbe(data, path, container, discovery.Duration, source.DurationMS)
}

type probeStream struct {
	Type     string `json:"codec_type"`
	Codec    string `json:"codec_name"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Duration string `json:"duration"`
	Start    string `json:"start_time"`
}
type probeResult struct {
	Streams []probeStream `json:"streams"`
	Format  struct {
		Name     string `json:"format_name"`
		Duration string `json:"duration"`
		Start    string `json:"start_time"`
		Size     string `json:"size"`
	} `json:"format"`
}

// durationTolerance autorise les arrondis et muxings, avec un plafond pour les longues vidéos.
func durationTolerance(seconds float64) float64 { return max(1, min(3, seconds*0.001)) }

func validateProbe(data []byte, path, container string, remoteDuration float64, storedDuration *int64) (media.Acquired, error) {
	var result probeResult
	if err := json.Unmarshal(data, &result); err != nil {
		return media.Acquired{}, media.ErrInvalid
	}
	if !probeContainerMatches(result.Format.Name, container, path) {
		return media.Acquired{}, media.ErrInvalid
	}

	duration, err := strconv.ParseFloat(result.Format.Duration, 64)
	if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration*1000 >= math.Exp2(63) {
		return media.Acquired{}, media.ErrInvalid
	}
	info, err := os.Lstat(path)
	if err != nil {
		return media.Acquired{}, err
	}
	size, err := strconv.ParseInt(result.Format.Size, 10, 64)
	if err != nil || !info.Mode().IsRegular() || size <= 0 || size != info.Size() {
		return media.Acquired{}, media.ErrInvalid
	}
	var videoStream, audioStream probeStream
	videos, audios := 0, 0
	for _, stream := range result.Streams {
		switch stream.Type {
		case "video":
			videos++
			videoStream = stream
		case "audio":
			audios++
			audioStream = stream
		default:
			return media.Acquired{}, media.ErrInvalid
		}
		// Les durées par flux ne sont pas toujours exposées (notamment WebM).
		if stream.Duration != "" && stream.Duration != "N/A" {
			value, err := strconv.ParseFloat(stream.Duration, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || math.Abs(value-duration) > durationTolerance(duration) {
				return media.Acquired{}, media.ErrDuration
			}
		}
		if stream.Start != "" && stream.Start != "N/A" {
			value, err := strconv.ParseFloat(stream.Start, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > durationTolerance(duration) {
				return media.Acquired{}, media.ErrDuration
			}
		}
	}
	if videos != 1 || audios != 1 || videoStream.Width <= 0 || videoStream.Height <= 0 || videoStream.Codec == "" || videoStream.Codec == "unknown" || audioStream.Codec == "" || audioStream.Codec == "unknown" {
		return media.Acquired{}, media.ErrInvalid
	}
	if math.Abs(duration-remoteDuration) > durationTolerance(remoteDuration) {
		return media.Acquired{}, fmt.Errorf("%w: local=%g discovered=%g seconds", media.ErrDuration, duration, remoteDuration)
	}
	if storedDuration != nil && math.Abs(duration-float64(*storedDuration)/1000) > durationTolerance(float64(*storedDuration)/1000) {
		return media.Acquired{}, fmt.Errorf("%w: local=%g stored=%g seconds", media.ErrDuration, duration, float64(*storedDuration)/1000)
	}
	return media.Acquired{Format: container, Size: size, DurationMS: int64(math.Round(duration * 1000))}, nil
}

// probeContainerMatches normalise les alias des démuxeurs, sans limiter les conteneurs admis.
func probeContainerMatches(demuxer, container, path string) bool {
	if container == "webm" {
		return strings.Contains(","+demuxer+",", ",webm,") && isWebM(path)
	}
	if container == "mkv" {
		return strings.Contains(","+demuxer+",", ",matroska,") && ebmlDocType(path) == "matroska"
	}
	aliases := map[string]string{"ts": "mpegts", "mpg": "mpeg", "m4v": "mp4", "ogv": "ogg"}
	if alias := aliases[container]; alias != "" {
		container = alias
	}
	return strings.Contains(","+demuxer+",", ","+container+",")
}

// mediaCommand borne les sorties et termine le groupe Linux, y compris ffmpeg descendant.
func mediaCommand(ctx context.Context, binary string, args ...string) ([]byte, error) {
	cmd := exec.Command(binary, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	stdout := &boundedOutput{limit: 64 << 20}
	stderr := &boundedOutput{limit: 16 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start media tool: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	select {
	case err = <-done:
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	case <-ctx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		// Conserver le délai même si le parent sort : un descendant peut ignorer SIGTERM.
		timer := time.NewTimer(time.Second)
		<-timer.C
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return nil, ctx.Err()
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("%w: %v: %s", media.ErrDownload, err, strings.TrimSpace(stderr.buffer.String()))
		}
		return nil, fmt.Errorf("media tool: %w", err)
	}
	if stdout.truncated {
		return nil, media.ErrInvalid
	}
	return stdout.buffer.Bytes(), nil
}

// isWebM lit seulement l'en-tête EBML borné, jamais les blocs du média.
func isWebM(path string) bool { return ebmlDocType(path) == "webm" }

// ebmlDocType distingue les conteneurs partageant le démuxeur Matroska/WebM.
func ebmlDocType(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4096))
	if err != nil || len(data) < 5 || !bytes.Equal(data[:4], []byte{0x1a, 0x45, 0xdf, 0xa3}) {
		return ""
	}
	size, n := ebmlInteger(data[4:], false)
	if n == 0 || size > uint64(len(data)-4-n) {
		return ""
	}
	end := 4 + n + int(size)
	for offset := 4 + n; offset < end; {
		id, n := ebmlInteger(data[offset:end], true)
		if n == 0 {
			return ""
		}
		offset += n
		length, n := ebmlInteger(data[offset:end], false)
		if n == 0 || length > uint64(end-offset-n) {
			return ""
		}
		offset += n
		if id == 0x4282 {
			return string(data[offset : offset+int(length)])
		}
		offset += int(length)
	}
	return ""
}

// ebmlInteger décode un VINT sans dépasser l'en-tête fourni ; zéro longueur indique une erreur.
func ebmlInteger(data []byte, identifier bool) (uint64, int) {
	if len(data) == 0 || data[0] == 0 {
		return 0, 0
	}
	n, mask := 1, byte(0x80)
	for data[0]&mask == 0 {
		n++
		mask >>= 1
	}
	if n > len(data) {
		return 0, 0
	}
	value := uint64(data[0])
	if !identifier {
		value &= uint64(mask - 1)
	}
	for _, b := range data[1:n] {
		value = value<<8 | uint64(b)
	}
	return value, n
}
