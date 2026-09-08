package ytdlp

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// metadata isole le format externe ; les champs non utilisés sont ignorés.
type metadata struct {
	Type         string   `json:"_type"`
	ExtractorKey string   `json:"extractor_key"`
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Description  string   `json:"description"`
	Channel      string   `json:"channel"`
	Uploader     string   `json:"uploader"`
	Duration     *float64 `json:"duration"`
	Thumbnail    string   `json:"thumbnail"`
}

func parseMetadata(data []byte) (video.VideoSource, error) {
	var raw metadata
	if err := json.Unmarshal(data, &raw); err != nil {
		return video.VideoSource{}, fmt.Errorf("parse yt-dlp metadata: %w", err)
	}
	if raw.Type != "" && raw.Type != "video" {
		return video.VideoSource{}, fmt.Errorf("expected a single video, got %q", raw.Type)
	}
	if raw.ExtractorKey != "Youtube" {
		return video.VideoSource{}, fmt.Errorf("unsupported extractor %q", raw.ExtractorKey)
	}
	id := strings.TrimSpace(raw.ID)
	title := strings.TrimSpace(raw.Title)
	if id == "" || title == "" {
		return video.VideoSource{}, fmt.Errorf("missing video ID or title")
	}

	var durationMS *int64
	if raw.Duration != nil {
		// Arrondir à la milliseconde la plus proche et refuser les dépassements.
		ms := math.Round(*raw.Duration * 1000)
		if *raw.Duration < 0 || math.IsNaN(ms) || math.IsInf(ms, 0) || ms >= math.Exp2(63) {
			return video.VideoSource{}, fmt.Errorf("invalid video duration: %v", *raw.Duration)
		}
		value := int64(ms)
		durationMS = &value
	}
	creator := strings.TrimSpace(raw.Channel)
	if creator == "" {
		creator = strings.TrimSpace(raw.Uploader)
	}
	return video.VideoSource{
		Provider:     "youtube",
		ExternalID:   id,
		CanonicalURL: "https://www.youtube.com/watch?v=" + url.QueryEscape(id),
		Title:        title,
		Description:  raw.Description,
		Creator:      creator,
		DurationMS:   durationMS,
		ThumbnailURL: raw.Thumbnail,
	}, nil
}
