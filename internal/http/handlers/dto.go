package handlers

import (
	"github.com/patrickbrouhard/sillage/internal/video"
	"time"
)

type videoResponse struct {
	ID        int64                 `json:"id"`
	CreatedAt time.Time             `json:"created_at"`
	Sources   []videoSourceResponse `json:"sources"`
}

type videoSourceResponse struct {
	ID           int64   `json:"id"`
	Provider     string  `json:"provider"`
	ExternalID   *string `json:"external_id"`
	CanonicalURL *string `json:"canonical_url"`
	Title        string  `json:"title"`
	Description  *string `json:"description"`
	Creator      *string `json:"creator"`
	DurationMS   *int64  `json:"duration_ms"`
	ThumbnailURL *string `json:"thumbnail_url"`
}

type videoListResponse struct {
	Videos []videoResponse `json:"videos"`
}

func toVideoResponse(v video.Video) videoResponse {
	result := videoResponse{ID: int64(v.ID), CreatedAt: v.CreatedAt.UTC(), Sources: make([]videoSourceResponse, 0, len(v.Sources))}
	for _, s := range v.Sources {
		result.Sources = append(result.Sources, videoSourceResponse{
			ID: int64(s.ID), Provider: s.Provider, ExternalID: optionalText(s.ExternalID),
			CanonicalURL: optionalText(s.CanonicalURL), Title: s.Title,
			Description: optionalText(s.Description), Creator: optionalText(s.Creator),
			DurationMS: s.DurationMS, ThumbnailURL: optionalText(s.ThumbnailURL),
		})
	}
	return result
}

// optionalText adapte la convention métier « chaîne vide = absente » au JSON nullable.
func optionalText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
