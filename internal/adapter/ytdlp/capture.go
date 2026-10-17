package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/asset"
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
}

func captureRemoteArgs(id string) []string {
	return []string{
		"--ignore-config", "--no-playlist", "--no-cache-dir", "--skip-download",
		"--socket-timeout", "15", "--retries", "1", "-f", "bv*", "-S", "res",
		"--print", "%(.{id,extractor_key,live_status,url,http_headers})j",
		"--", "https://www.youtube.com/watch?v=" + id,
	}
}

// Extract garde les erreurs de stockage distinctes des erreurs de lecture, seules éligibles au repli.
func (c CaptureClient) Extract(ctx context.Context, source video.VideoSource, local string, timestamp int64, stage string) error {
	binary, probe, ffmpeg := c.Binary, c.ProbeBinary, c.FFmpegBinary
	if binary == "" {
		binary = "yt-dlp"
	}
	if probe == "" {
		probe = "ffprobe"
	}
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	input := local
	options := []string{}
	if input == "" {
		if source.Provider != "youtube" || !regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`).MatchString(source.ExternalID) {
			return asset.ErrExtract
		}
		data, err := mediaCommand(ctx, binary, captureRemoteArgs(source.ExternalID)...)
		if err != nil {
			return extractionError(ctx, err)
		}
		var remote captureInput
		if err := json.Unmarshal(data, &remote); err != nil {
			return extractionError(ctx, err)
		}
		parsed, err := url.Parse(remote.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil ||
			remote.ID != source.ExternalID || remote.Extractor != "Youtube" ||
			(remote.LiveStatus != "not_live" && remote.LiveStatus != "was_live") {
			return asset.ErrExtract
		}
		input = remote.URL
		options = []string{"-protocol_whitelist", "http,https,tcp,tls,crypto", "-rw_timeout", "15000000"}
		keys := make([]string, 0, len(remote.Headers))
		for key := range remote.Headers {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var headers strings.Builder
		for _, key := range keys {
			value := remote.Headers[key]
			if !regexp.MustCompile(`^[A-Za-z0-9-]+$`).MatchString(key) || strings.ContainsAny(value, "\r\n") {
				return asset.ErrExtract
			}
			fmt.Fprintf(&headers, "%s: %s\r\n", key, value)
		}
		if headers.Len() > 0 {
			options = append(options, "-headers", headers.String())
		}
	}
	// Les propriétés d'affichage ne sont pas déduites des seules dimensions MediaFile.
	args := append([]string{"-v", "error"}, options...)
	args = append(args, "-select_streams", "v:0", "-show_entries", "stream=codec_name,color_transfer,sample_aspect_ratio:format=duration", "-of", "json", input)
	data, err := mediaCommand(ctx, probe, args...)
	if err != nil {
		return extractionError(ctx, err)
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
		return fmt.Errorf("%w: non-square pixels unsupported", asset.ErrExtract)
	}
	duration, _ := strconv.ParseFloat(info.Format.Duration, 64)
	if duration > 0 && !math.IsInf(duration, 0) && float64(timestamp)/1000 >= duration {
		return fmt.Errorf("%w: timestamp beyond final frame", asset.ErrExtract)
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
	png, err := mediaCommand(ctx, ffmpeg, args...)
	if err != nil {
		return extractionError(ctx, err)
	}
	if len(png) == 0 {
		return fmt.Errorf("%w: no frame at timestamp", asset.ErrExtract)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// L'écriture se produit après décodage : ENOSPC n'entraîne jamais de repli réseau.
	return os.WriteFile(filepath.Join(stage, "frame.png"), png, 0600)
}

func extractionError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Ne pas journaliser les URL signées ou les en-têtes éventuellement présents dans stderr.
	var path *os.PathError
	if errors.As(err, &path) {
		return fmt.Errorf("%w: tool unavailable", asset.ErrExtract)
	}
	return fmt.Errorf("%w: media tool failed", asset.ErrExtract)
}
