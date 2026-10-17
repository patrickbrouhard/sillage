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

// mediaInfo ne conserve que l'identité et les informations utiles à la validation.
type mediaInfo struct {
	ID         string  `json:"id"`
	Extractor  string  `json:"extractor_key"`
	Duration   float64 `json:"duration"`
	LiveStatus string  `json:"live_status"`
	Path       string  `json:"filepath"`
	AudioCodec string  `json:"acodec"`
	Language   string  `json:"language"`
}

type selectedAudio struct {
	Codec    string `json:"acodec"`
	Language string `json:"language"`
}

// mediaDownloadArgs laisse le choix des représentations à yt-dlp. Le filtre natif
// s'exécute avant les octets ; le préambule permet de diagnostiquer un refus sans stderr.
func mediaDownloadArgs(id, stage string) []string {
	return []string{
		"--ignore-config", "--no-playlist", "--no-progress", "--no-cache-dir",
		"--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3",
		"--no-simulate", "--no-continue", "--abort-on-unavailable-fragments",
		"--no-keep-video", "--no-audio-multistreams", "--no-video-multistreams",
		"--format", "bv*+ba/b", "-S", "res:1080",
		"--match-filters", "id = '" + id + "' & extractor_key = 'Youtube' & live_status ~= '^(not_live|was_live)$'",
		"--print", "pre_process:source:%(.{id,extractor_key,live_status,duration})j",
		"--print", `after_move:result:{"file":%(.{id,extractor_key,live_status,duration,filepath,acodec,language})j,"tracks":%(requested_formats.:.{acodec,language}|)j}`,
		"--output", filepath.Join(stage, "media.%(ext)s"),
		"--", "https://www.youtube.com/watch?v=" + id,
	}
}

// parseMediaOutput exige un résultat final unique ; un filtrage sans téléchargement
// peut réussir au niveau processus et ne doit jamais être confondu avec une acquisition.
func parseMediaOutput(output []byte, id string) (mediaInfo, *string, error) {
	var source *mediaInfo
	var result *struct {
		File   mediaInfo       `json:"file"`
		Tracks []selectedAudio `json:"tracks"`
	}
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte("\n")) {
		switch {
		case bytes.HasPrefix(line, []byte("source:")):
			if source != nil || json.Unmarshal(bytes.TrimPrefix(line, []byte("source:")), &source) != nil || source == nil {
				return mediaInfo{}, nil, media.ErrInvalid
			}
		case bytes.HasPrefix(line, []byte("result:")):
			if result != nil || json.Unmarshal(bytes.TrimPrefix(line, []byte("result:")), &result) != nil || result == nil {
				return mediaInfo{}, nil, media.ErrInvalid
			}
		default:
			return mediaInfo{}, nil, media.ErrInvalid
		}
	}
	if source == nil || source.ID != id || source.Extractor != "Youtube" {
		return mediaInfo{}, nil, media.ErrInvalid
	}
	if source.LiveStatus != "not_live" && source.LiveStatus != "was_live" {
		return mediaInfo{}, nil, media.ErrUnfinished
	}
	if result == nil || result.File.ID != id || result.File.Extractor != "Youtube" ||
		result.File.LiveStatus != source.LiveStatus || result.File.Path == "" {
		return mediaInfo{}, nil, media.ErrInvalid
	}
	// En cas d'assemblage, la langue globale peut agréger les composants.
	// Seule la représentation audio effectivement retenue fait référence.
	language := result.File.Language
	if len(result.Tracks) > 0 {
		count := 0
		language = ""
		for _, track := range result.Tracks {
			if track.Codec != "" && track.Codec != "none" {
				count++
				language = track.Language
			}
		}
		if count != 1 {
			return mediaInfo{}, nil, media.ErrInvalid
		}
	} else if result.File.AudioCodec == "" || result.File.AudioCodec == "none" {
		return mediaInfo{}, nil, media.ErrInvalid
	}
	var declared *string
	if usableLanguage(strings.ToLower(language)) {
		declared = &language
	}
	return result.File, declared, nil
}

// Download extrait, sélectionne et acquiert en un appel, puis valide le fichier réel.
func (c MediaClient) Download(ctx context.Context, source video.VideoSource, stage string) (media.Acquired, error) {
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
	output, err := mediaCommand(ctx, binary, mediaDownloadArgs(source.ExternalID, stage)...)
	if err != nil {
		return media.Acquired{}, err
	}
	info, language, err := parseMediaOutput(output, source.ExternalID)
	if err != nil {
		return media.Acquired{}, err
	}
	path := info.Path
	container := strings.TrimPrefix(filepath.Ext(path), ".")
	// Le chemin final est encore temporaire et ne doit dépendre d'aucun titre.
	if filepath.Clean(filepath.Dir(path)) != filepath.Clean(stage) ||
		filepath.Base(path) != "media."+container ||
		!regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`).MatchString(container) {
		return media.Acquired{}, media.ErrInvalid
	}
	probe := c.ProbeBinary
	if probe == "" {
		probe = "ffprobe"
	}
	data, err := mediaCommand(ctx, probe, "-v", "error", "-show_format", "-show_streams", "-of", "json", path)
	if err != nil {
		if ctx.Err() != nil {
			return media.Acquired{}, ctx.Err()
		}
		return media.Acquired{}, fmt.Errorf("%w: probe: %v", media.ErrInvalid, err)
	}
	acquired, err := validateProbe(data, path, container, info.Duration, source.DurationMS)
	acquired.AudioLanguage = language
	return acquired, err
}

type probeStream struct {
	Type        string `json:"codec_type"`
	Codec       string `json:"codec_name"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Duration    string `json:"duration"`
	Start       string `json:"start_time"`
	AverageRate string `json:"avg_frame_rate"`
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
	if remoteDuration > 0 && !math.IsInf(remoteDuration, 0) && math.Abs(duration-remoteDuration) > durationTolerance(remoteDuration) {
		return media.Acquired{}, fmt.Errorf("%w: local=%g discovered=%g seconds", media.ErrDuration, duration, remoteDuration)
	}
	if storedDuration != nil && math.Abs(duration-float64(*storedDuration)/1000) > durationTolerance(float64(*storedDuration)/1000) {
		return media.Acquired{}, fmt.Errorf("%w: local=%g stored=%g seconds", media.ErrDuration, duration, float64(*storedDuration)/1000)
	}
	return media.Acquired{
		Format:     container,
		Size:       size,
		DurationMS: int64(math.Round(duration * 1000)),
		VideoCodec: &videoStream.Codec,
		AudioCodec: &audioStream.Codec,
		Width:      &videoStream.Width,
		Height:     &videoStream.Height,
		FPS:        averageFPS(videoStream.AverageRate),
	}, nil
}

// averageFPS interprète la cadence moyenne rationnelle ; une cadence inconnue reste NULL.
func averageFPS(rate string) *float64 {
	numerator, denominator, ok := strings.Cut(rate, "/")
	if !ok {
		return nil
	}
	n, en := strconv.ParseFloat(numerator, 64)
	d, ed := strconv.ParseFloat(denominator, 64)
	fps := n / d
	if en != nil || ed != nil || n <= 0 || d <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) || fps <= 0 {
		return nil
	}
	return &fps
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
