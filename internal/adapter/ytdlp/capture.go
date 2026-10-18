package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// CaptureClient résout uniquement la vidéo et décode une frame en PNG.
type CaptureClient struct {
	Binary       string
	ProbeBinary  string
	FFmpegBinary string
}

type captureInput struct {
	URL        string            `json:"url"`
	Headers    map[string]string `json:"http_headers"`
	ID         string            `json:"id"`
	Extractor  string            `json:"extractor_key"`
	LiveStatus string            `json:"live_status"`
	Protocol   string            `json:"protocol"`
	Width      int               `json:"width"`
	Height     int               `json:"height"`
}

// captureRemoteArgs privilégie les dimensions puis HTTPS, avant les préférences de l'extracteur.
// Le sélecteur bv* exclut l'audio seul même avec le classement forcé, réservé aux captures.
func captureRemoteArgs(id, selector string) []string {
	return []string{
		"--ignore-config", "--no-playlist", "--no-cache-dir", "--skip-download",
		"--socket-timeout", "15", "--retries", "1", "-f", selector, "--format-sort-force", "-S", "res,width,height,proto",
		"--print", "%(.{id,extractor_key,live_status,url,http_headers,protocol,width,height})j",
		"--", "https://www.youtube.com/watch?v=" + id,
	}
}

// Extract garde les erreurs de stockage distinctes des erreurs de lecture, seules éligibles au repli.
func (c CaptureClient) Extract(ctx context.Context, source video.VideoSource, local string, timestamp int64, stage string) error {
	if local != "" {
		return c.extractInput(ctx, local, nil, timestamp, stage)
	}

	selector := "bv*"
	renewed := false
	fallbackWidth, fallbackHeight := 0, 0
	// Au maximum : sélection initiale, changement de transport, renouvellement unique.
	// Le budget de renouvellement est partagé, quel que soit le transport refusé.
	for attempt := 0; attempt < 3; attempt++ {
		remote, options, err := c.resolveCapture(ctx, source, selector)
		if err != nil {
			return err
		}
		if fallbackWidth > 0 && (remote.Protocol != "https" ||
			remote.Width != fallbackWidth || remote.Height != fallbackHeight) {
			return &captureFailure{stage: "resolve", reason: "no_same_resolution_https"}
		}
		logging.From(ctx).DebugContext(ctx, "Capture input selected", "event", "capture.input_selected", "attempt", attempt+1, "transport", captureTransport(remote.Protocol), "width", remote.Width, "height", remote.Height)
		err = c.extractInput(ctx, remote.URL, options, timestamp, stage)
		if !renewed && ctx.Err() == nil && captureReason(err, "http_403") {
			renewed = true
			// Conserver le sélecteur courant, notamment les dimensions du repli HTTPS.
			logging.From(ctx).WarnContext(ctx, "Renewing rejected remote URL", "event", "capture.url_renewed", "attempt", attempt+1, "reason", "http_403")
			continue
		}
		var failure *captureFailure
		if fallbackWidth == 0 && ctx.Err() == nil && errors.As(err, &failure) && failure.transportFailure &&
			(failure.stage == "probe" || failure.stage == "decode") &&
			(remote.Protocol == "m3u8" || remote.Protocol == "m3u8_native") &&
			remote.Width > 0 && remote.Height > 0 {
			logging.From(ctx).WarnContext(ctx, "Capture falling back to HTTPS", "event", "capture.fallback", "attempt", attempt+1, "reason", failure.reason, "width", remote.Width, "height", remote.Height)
			fallbackWidth, fallbackHeight = remote.Width, remote.Height
			selector = fmt.Sprintf("bv*[protocol=https][width=%d][height=%d]", fallbackWidth, fallbackHeight)
			continue
		}
		return err
	}
	return asset.ErrExtract
}

func (c CaptureClient) resolveCapture(ctx context.Context, source video.VideoSource, selector string) (captureInput, []string, error) {
	binary := c.Binary
	if binary == "" {
		binary = "yt-dlp"
	}
	if source.Provider != "youtube" || !regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`).MatchString(source.ExternalID) {
		return captureInput{}, nil, asset.ErrExtract
	}
	data, err := captureCommand(ctx, "resolve", binary, captureRemoteArgs(source.ExternalID, selector)...)
	if err != nil {
		return captureInput{}, nil, err
	}
	var remote captureInput
	if err := json.Unmarshal(data, &remote); err != nil {
		return captureInput{}, nil, &captureFailure{stage: "resolve", reason: "invalid_json"}
	}
	parsed, err := url.Parse(remote.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil ||
		remote.ID != source.ExternalID || remote.Extractor != "Youtube" ||
		(remote.LiveStatus != "not_live" && remote.LiveStatus != "was_live") {
		return captureInput{}, nil, asset.ErrExtract
	}

	options := []string{"-protocol_whitelist", "http,https,tcp,tls,crypto", "-rw_timeout", "15000000"}
	keys := make([]string, 0, len(remote.Headers))
	for key := range remote.Headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var headers strings.Builder
	for _, key := range keys {
		value := remote.Headers[key]
		if !regexp.MustCompile(`^[A-Za-z0-9-]+$`).MatchString(key) || strings.ContainsAny(value, "\r\n") {
			return captureInput{}, nil, asset.ErrExtract
		}
		fmt.Fprintf(&headers, "%s: %s\r\n", key, value)
	}
	if headers.Len() > 0 {
		options = append(options, "-headers", headers.String())
	}
	return remote, options, nil
}

// extractInput garde la même politique de seek pour le fichier et le flux distant.
func (c CaptureClient) extractInput(ctx context.Context, input string, options []string, timestamp int64, stage string) error {
	probe, ffmpeg := c.ProbeBinary, c.FFmpegBinary
	if probe == "" {
		probe = "ffprobe"
	}
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	// Les propriétés d'affichage ne sont pas déduites des seules dimensions MediaFile.
	args := append([]string{"-v", "error"}, options...)
	args = append(args, "-select_streams", "v:0", "-show_entries", "stream=codec_name,color_transfer,sample_aspect_ratio:format=duration", "-of", "json", input)
	data, err := captureCommand(ctx, "probe", probe, args...)
	if err != nil {
		return err
	}
	var info struct {
		Streams []struct {
			Codec    string `json:"codec_name"`
			Transfer string `json:"color_transfer"`
			SAR      string `json:"sample_aspect_ratio"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(data, &info); err != nil || len(info.Streams) == 0 {
		return asset.ErrExtract
	}
	stream := info.Streams[0]
	if stream.Codec == "" {
		return asset.ErrExtract
	}
	// Sans redimensionnement, des pixels non carrés donneraient une image déformée.
	if stream.SAR != "" && stream.SAR != "N/A" && stream.SAR != "0:1" && stream.SAR != "1:1" {
		return &captureFailure{stage: "probe", reason: "non_square_pixels"}
	}
	duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
	if duration > 0 && !math.IsInf(duration, 0) && float64(timestamp)/1000 >= duration {
		return &captureFailure{stage: "probe", reason: "timestamp_beyond_final_frame"}
	}
	filter := "format=rgb24"
	if stream.Transfer == "smpte2084" || stream.Transfer == "arib-std-b67" {
		filter = "zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,tonemap=hable:desat=0,zscale=transfer=bt709:matrix=gbr:range=full,format=rgb24"
	}
	// Le seek d'entrée précis décode depuis le point d'accès précédent, sans stream copy.
	// Le résultat est la première frame à partir de la cible, dans la timeline du démuxeur.
	args = append([]string{"-v", "error", "-nostdin"}, options...)
	args = append(args,
		"-ss", fmt.Sprintf("%d.%03d", timestamp/1000, timestamp%1000),
		"-accurate_seek", "-i", input, "-map", "0:v:0", "-an", "-sn", "-dn",
		"-frames:v", "1", "-vf", filter, "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
	)
	png, err := captureCommand(ctx, "decode", ffmpeg, args...)
	if err != nil {
		return err
	}
	if len(png) == 0 {
		return &captureFailure{stage: "decode", reason: "no_frame_at_timestamp", transportFailure: true}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// L'écriture se produit après décodage : ENOSPC n'entraîne jamais de repli réseau.
	return os.WriteFile(filepath.Join(stage, "frame.png"), png, 0600)
}

// captureCommand journalise seulement des étapes et catégories fermées, jamais stderr.
func captureCommand(ctx context.Context, stage, binary string, args ...string) ([]byte, error) {
	tool := "ffmpeg"
	if stage == "resolve" {
		tool = "yt-dlp"
	} else if stage == "probe" {
		tool = "ffprobe"
	}
	ctx = logging.WithLogger(ctx, logging.From(ctx).With("tool", tool))
	started := time.Now()
	data, err := mediaCommand(ctx, binary, args...)
	if err != nil {
		safe := extractionError(ctx, stage, err)
		logging.From(ctx).DebugContext(ctx, "Capture command failed", "event", "capture.command_finished", "stage", stage, "elapsed_ms", time.Since(started).Milliseconds(), logging.Error(safe))
		return nil, safe
	}
	logging.From(ctx).DebugContext(ctx, "Capture command completed", "event", "capture.command_finished", "stage", stage, "elapsed_ms", time.Since(started).Milliseconds(), "output_bytes", len(data))
	return data, nil
}

// captureTransport n'autorise aucune chaîne externe arbitraire dans les journaux.
func captureTransport(protocol string) string {
	switch protocol {
	case "https", "http", "m3u8", "m3u8_native", "http_dash_segments":
		return protocol
	default:
		return "unknown"
	}
}

func extractionError(ctx context.Context, stage string, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("stage=%s: %w", stage, ctx.Err())
	}
	var path *os.PathError
	var executable *exec.Error
	if errors.As(err, &path) || errors.As(err, &executable) {
		return toolError(err, "")
	}
	var failure *toolFailure
	if errors.As(err, &failure) {
		return &captureFailure{stage: stage, reason: failure.reason, exitCode: &failure.exitCode, transportFailure: true}
	}
	return &captureFailure{stage: stage, reason: toolReason(err.Error()), transportFailure: true}
}

// toolReason réutilise les catégories fermées des captures, sans piloter les autres acquisitions.
func toolReason(message string) string {
	// Classifier le message privé, sans jamais le recopier même après une rédaction.
	// Les valeurs produites sont constantes : URL, cookies et en-têtes restent privés.
	reason := "tool_failed"
	message = strings.ToLower(message)
	for _, category := range []struct{ pattern, code string }{
		{"403 forbidden", "http_403"},
		{"http error 403", "http_403"},
		{"404 not found", "http_404"},
		{"http error 429", "http_429"},
		{"connection timed out", "network_timeout"},
		{"connection reset", "connection_reset"},
		{"server returned 5", "http_5xx"},
		{"invalid data found", "invalid_media"},
		{"partial file", "partial_media"},
		{"resource temporarily unavailable", "resource_unavailable"},
		{"no such filter", "filter_unavailable"},
		{"decoder not found", "decoder_unavailable"},
		{"requested format is not available", "format_unavailable"},
		{"sign in", "authentication_required"},
	} {
		if strings.Contains(message, category.pattern) {
			reason = category.code
			break
		}
	}
	return reason
}

// captureFailure transporte une catégorie fermée, sans conserver le diagnostic privé.
type captureFailure struct {
	stage, reason string
	exitCode      *int
	// Seuls les échecs de commande et l'absence de frame autorisaient le repli HLS.
	// Un diagnostic de validation ne doit pas modifier cette politique.
	transportFailure bool
}

// Error conserve les motifs stables d’extraction sans détail externe.
func (e *captureFailure) Error() string {
	return fmt.Sprintf("%s: stage=%s reason=%s", asset.ErrExtract, e.stage, e.reason)
}

// Unwrap maintient les seuls replis autorisés par ErrExtract.
func (e *captureFailure) Unwrap() error { return asset.ErrExtract }
func captureReason(err error, reason string) bool {
	var failure *captureFailure
	return errors.As(err, &failure) && failure.reason == reason
}

// LogValue ne conserve que les catégories fermées du diagnostic d'extraction.
func (e *captureFailure) LogValue() slog.Value {
	attrs := []slog.Attr{slog.String("stage", e.stage), slog.String("reason", e.reason)}
	if e.exitCode != nil {
		attrs = append(attrs, slog.Int("exit_code", *e.exitCode))
	}
	return slog.GroupValue(attrs...)
}
