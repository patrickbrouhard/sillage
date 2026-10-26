// Package mcp adapte les lectures applicatives au protocole MCP sans acquisition distante.
package mcp

import (
	"time"

	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type searchInput struct {
	Query string `json:"query"`
	Page  int    `json:"page,omitempty"`
	Sort  string `json:"sort,omitempty"`
}

type videoInput struct {
	VideoID video.VideoID `json:"video_id"`
}

type transcriptInput struct {
	VideoID  video.VideoID       `json:"video_id"`
	SourceID video.VideoSourceID `json:"source_id"`
	Format   string              `json:"format,omitempty"`
}

type tagDTO struct {
	ID   video.TagID `json:"id"`
	Name string      `json:"name"`
}

type publisherDTO struct {
	ID         video.PublisherID `json:"id"`
	Provider   string            `json:"provider"`
	ExternalID string            `json:"external_id"`
	Name       string            `json:"name"`
	PersonID   *video.PersonID   `json:"person_id"`
}

// sourceDTO contient la provenance compacte, sans description longue ni chemin local.
type sourceDTO struct {
	ID                    video.VideoSourceID `json:"id"`
	Provider              string              `json:"provider"`
	ExternalID            string              `json:"external_id"`
	CanonicalURL          string              `json:"canonical_url,omitempty"`
	Title                 string              `json:"title"`
	Publisher             *publisherDTO       `json:"publisher"`
	DurationMS            *int64              `json:"duration_ms"`
	OriginalAudioLanguage string              `json:"original_audio_language"`
}

type fullSourceDTO struct {
	sourceDTO
	Description string `json:"description"`
}

type videoDTO struct {
	ID        video.VideoID    `json:"id"`
	CreatedAt string           `json:"created_at"`
	Sources   []fullSourceDTO  `json:"sources"`
	Tags      []tagDTO         `json:"tags"`
	PersonIDs []video.PersonID `json:"person_ids"`
}

type compactVideoDTO struct {
	ID        video.VideoID `json:"id"`
	CreatedAt string        `json:"created_at"`
	Sources   []sourceDTO   `json:"sources"`
	Tags      []tagDTO      `json:"tags"`
}

type searchResultDTO struct {
	Video         compactVideoDTO      `json:"video"`
	NoteExcerpt   []search.Segment     `json:"note_excerpt"`
	SourceMatches []search.SourceMatch `json:"source_matches"`
}

type searchDTO struct {
	Results []searchResultDTO `json:"results"`
	Page    int               `json:"page"`
	Total   int64             `json:"total"`
	HasMore bool              `json:"has_more"`
}

type fragmentDTO struct {
	StartMS int64  `json:"start_ms"`
	Text    string `json:"text"`
}

type transcriptDTO struct {
	VideoID       video.VideoID       `json:"video_id"`
	SourceID      video.VideoSourceID `json:"source_id"`
	TranscriptID  int64               `json:"transcript_id"`
	Language      string              `json:"language"`
	Provenance    string              `json:"provenance"`
	LastFetchedAt string              `json:"last_fetched_at"`
	Format        string              `json:"format"`
	Complete      bool                `json:"complete"`
	Text          *string             `json:"text,omitempty"`
	Fragments     *[]fragmentDTO      `json:"fragments,omitempty"`
}

type noteDTO struct {
	VideoID   video.VideoID `json:"video_id"`
	ContentMD string        `json:"content_md"`
	Revision  int64         `json:"revision"`
	CreatedAt string        `json:"created_at"`
	UpdatedAt string        `json:"updated_at"`
}

func utc(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func tagsDTO(tags []video.Tag) []tagDTO {
	result := make([]tagDTO, 0, len(tags))
	for _, tag := range tags {
		result = append(result, tagDTO{ID: tag.ID, Name: tag.Name})
	}
	return result
}

func sourceMetadata(source video.VideoSource) sourceDTO {
	var publisher *publisherDTO
	if p := source.Publisher; p != nil {
		publisher = &publisherDTO{
			ID:         p.ID,
			Provider:   p.Provider,
			ExternalID: p.ExternalID,
			Name:       p.Name,
			PersonID:   p.PersonID,
		}
	}
	return sourceDTO{
		ID:                    source.ID,
		Provider:              source.Provider,
		ExternalID:            source.ExternalID,
		CanonicalURL:          source.CanonicalURL,
		Title:                 source.Title,
		Publisher:             publisher,
		DurationMS:            source.DurationMS,
		OriginalAudioLanguage: source.OriginalAudioLanguage,
	}
}
