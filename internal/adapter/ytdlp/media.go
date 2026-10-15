package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
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
	ID                 string          `json:"format_id"`
	Extension          string          `json:"ext"`
	VideoCodec         string          `json:"vcodec"`
	AudioCodec         string          `json:"acodec"`
	Width              int             `json:"width"`
	Height             int             `json:"height"`
	FPS                float64         `json:"fps"`
	Language           string          `json:"language"`
	LanguagePreference int             `json:"language_preference"`
	Preference         *float64        `json:"preference"`
	DRM                json.RawMessage `json:"has_drm"`
	URL                string          `json:"url"`
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

type mediaChoice struct {
	video, audio mediaFormat
	format       string
	order        int
}

var formatID = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)

func videoCodec(codec string) string {
	for _, pair := range [][2]string{{"avc1", "h264"}, {"h264", "h264"}, {"av01", "av1"}, {"av1", "av1"}, {"vp09", "vp9"}, {"vp9", "vp9"}, {"vp8", "vp8"}} {
		if strings.HasPrefix(codec, pair[0]) {
			return pair[1]
		}
	}
	return ""
}

func audioCodec(codec string) string {
	for _, pair := range [][2]string{{"mp4a", "aac"}, {"aac", "aac"}, {"opus", "opus"}, {"vorbis", "vorbis"}} {
		if strings.HasPrefix(codec, pair[0]) {
			return pair[1]
		}
	}
	return ""
}

func compatible(container, vcodec, acodec string) bool {
	switch container {
	case "mp4":
		return (vcodec == "h264" || vcodec == "av1") && acodec == "aac"
	case "webm":
		return (vcodec == "vp8" || vcodec == "vp9" || vcodec == "av1") && (acodec == "opus" || acodec == "vorbis")
	}
	return false
}

func fullHD(width, height int) bool {
	return width > 0 && height > 0 && min(width, height) <= 1080 && max(width, height) <= 1920
}

func usableFormat(f mediaFormat) bool {
	drm := string(f.DRM)
	u, err := url.Parse(f.URL)
	return formatID.MatchString(f.ID) && err == nil && u.Scheme == "https" && u.Host != "" &&
		(drm == "" || drm == "null" || drm == "false") && (f.Preference == nil || *f.Preference > -10)
}

// chooseMedia sépare l'identité audio des variantes de codec et classe les combinaisons complètes.
func chooseMedia(d mediaDiscovery, knownLanguage string) (mediaChoice, error) {
	languages := make(map[string]bool)
	originals := make(map[string]bool)
	for _, f := range d.Formats {
		if !usableFormat(f) || f.AudioCodec == "" || f.AudioCodec == "none" || f.LanguagePreference < -1 {
			continue
		}
		languages[f.Language] = true
		if f.LanguagePreference == 10 && usableLanguage(f.Language) {
			originals[f.Language] = true
		}
	}
	language := ""
	switch {
	case len(originals) > 1:
		return mediaChoice{}, media.ErrAudio
	case len(originals) == 1:
		for value := range originals {
			language = value
		}
	case knownLanguage != "" && languages[knownLanguage]:
		language = knownLanguage
	case len(languages) == 1:
		for value := range languages {
			language = value
		}
	case len(languages) == 0:
		return mediaChoice{}, media.ErrSelection
	default:
		return mediaChoice{}, media.ErrAudio
	}
	allowedAudio := func(f mediaFormat) bool {
		return usableFormat(f) && f.Language == language && f.LanguagePreference >= -1 && audioCodec(f.AudioCodec) != ""
	}
	var best mediaChoice
	found := false
	for index, v := range d.Formats {
		if !usableFormat(v) || !fullHD(v.Width, v.Height) || videoCodec(v.VideoCodec) == "" || (v.Extension != "mp4" && v.Extension != "webm") {
			continue
		}
		consider := func(a mediaFormat) {
			if !allowedAudio(a) || !compatible(v.Extension, videoCodec(v.VideoCodec), audioCodec(a.AudioCodec)) {
				return
			}
			choice := mediaChoice{video: v, audio: a, format: v.Extension, order: index}
			if !found || betterMedia(choice, best) {
				best = choice
				found = true
			}
		}
		if v.AudioCodec != "" && v.AudioCodec != "none" {
			consider(v)
			continue
		}
		// La liste de yt-dlp est ordonnée de la moins à la plus préférée.
		// À vidéo égale, la dernière variante audio admissible l'emporte.
		for _, a := range d.Formats {
			if a.VideoCodec == "none" {
				consider(a)
			}
		}
	}
	if !found {
		return mediaChoice{}, media.ErrSelection
	}
	return best, nil
}

func betterMedia(a, b mediaChoice) bool {
	if x, y := min(a.video.Width, a.video.Height), min(b.video.Width, b.video.Height); x != y {
		return x > y
	}
	if x, y := a.video.Width*a.video.Height, b.video.Width*b.video.Height; x != y {
		return x > y
	}
	if a.video.FPS != b.video.FPS {
		return a.video.FPS > b.video.FPS
	}
	if a.format != b.format {
		return a.format == "mp4"
	}
	return a.order >= b.order
}

// Download découvre une fois la source et réutilise cette découverte pour des pistes explicites.
func (c MediaClient) Download(ctx context.Context, source video.VideoSource, stage string) (media.Acquired, error) {
	if source.Provider != "youtube" || !regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`).MatchString(source.ExternalID) {
		return media.Acquired{}, media.ErrUnsupported
	}
	binary := c.Binary
	if binary == "" {
		binary = "yt-dlp"
	}
	common := []string{"--ignore-config", "--no-playlist", "--no-progress", "--no-cache-dir", "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3"}
	args := append(append([]string{}, common...), "--dump-single-json", "--simulate", "--", "https://www.youtube.com/watch?v="+source.ExternalID)
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
	choice, err := chooseMedia(discovery, source.OriginalAudioLanguage)
	if err != nil {
		return media.Acquired{}, err
	}
	info := filepath.Join(stage, "source.json")
	if err := os.WriteFile(info, data, 0600); err != nil {
		return media.Acquired{}, err
	}
	selected := choice.video.ID
	if choice.audio.ID != choice.video.ID {
		selected += "+" + choice.audio.ID
	}
	args = append(append([]string{}, common...),
		"--load-info-json", info, "--no-simulate", "--no-continue",
		"--abort-on-unavailable-fragments", "--no-keep-video",
		"--format", selected, "--merge-output-format", choice.format, "--remux-video", choice.format,
		"--output", filepath.Join(stage, "media.%(ext)s"))
	if _, err := mediaCommand(ctx, binary, args...); err != nil {
		return media.Acquired{}, err
	}
	probe := c.ProbeBinary
	if probe == "" {
		probe = "ffprobe"
	}
	path := filepath.Join(stage, "media."+choice.format)
	data, err = mediaCommand(ctx, probe, "-v", "error", "-show_format", "-show_streams", "-of", "json", path)
	if err != nil {
		return media.Acquired{}, fmt.Errorf("%w: probe: %v", media.ErrInvalid, err)
	}
	return validateProbe(data, path, choice.format, discovery.Duration, source.DurationMS)
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
	if (container == "mp4" && !strings.Contains(","+result.Format.Name+",", ",mp4,")) || (container == "webm" && !strings.Contains(","+result.Format.Name+",", ",webm,")) {
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
	if videos != 1 || audios != 1 || !fullHD(videoStream.Width, videoStream.Height) || !compatible(container, videoStream.Codec, audioStream.Codec) {
		return media.Acquired{}, media.ErrInvalid
	}
	if math.Abs(duration-remoteDuration) > durationTolerance(remoteDuration) {
		return media.Acquired{}, media.ErrDuration
	}
	if storedDuration != nil && math.Abs(duration-float64(*storedDuration)/1000) > durationTolerance(float64(*storedDuration)/1000) {
		return media.Acquired{}, media.ErrDuration
	}
	return media.Acquired{Format: container, Size: size, DurationMS: int64(math.Round(duration * 1000))}, nil
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
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("%w: %v", media.ErrDownload, err)
		}
		return nil, fmt.Errorf("media tool: %w", err)
	}
	if stdout.truncated {
		return nil, media.ErrInvalid
	}
	return stdout.buffer.Bytes(), nil
}
