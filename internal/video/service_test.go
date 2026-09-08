package video

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestAddVideoCreatesThenReturnsExistingWithoutRefresh(t *testing.T) {
	source := VideoSource{
		Provider: "youtube", ExternalID: "same", CanonicalURL: "https://www.youtube.com/watch?v=same",
		Title: "Original", Description: "Description", Creator: "Créateur", ThumbnailURL: "https://example.com/original",
	}
	var stored Video
	creates := 0
	repo := stubRepository{
		find: func(ctx context.Context, provider, externalID string) (Video, error) {
			if provider != "youtube" || externalID != "same" {
				t.Fatal("incorrect source identity")
			}
			if stored.ID == 0 {
				return Video{}, ErrVideoNotFound
			}
			return stored, nil
		},
		create: func(ctx context.Context, v Video) (Video, error) {
			creates++
			if v.CreatedAt.IsZero() || v.CreatedAt.After(time.Now()) || !reflect.DeepEqual(v.Sources, []VideoSource{source}) {
				t.Fatalf("unexpected creation: %#v", v)
			}
			v.ID = 42
			v.Sources[0].ID = 7
			v.Sources[0].VideoID = v.ID
			stored = v
			return v, nil
		},
	}
	urls := []string{}
	provider := providerFunc(func(ctx context.Context, url string) (VideoSource, error) {
		urls = append(urls, url)
		if len(urls) == 1 {
			return source, nil
		}
		changed := source
		changed.Title, changed.Description, changed.Creator, changed.ThumbnailURL = "Changed", "Changed", "Changed", "Changed"
		return changed, nil
	})
	service := NewService(repo, provider)
	first, err := service.AddVideo(context.Background(), "https://youtu.be/same")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.AddVideo(context.Background(), "https://www.youtube.com/watch?v=same")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) || creates != 1 || len(urls) != 2 {
		t.Fatalf("idempotence failed: %#v / %#v, creates=%d urls=%v", first, second, creates, urls)
	}
}

func TestAddVideoPropagatesErrors(t *testing.T) {
	failure := errors.New("failure")
	source := VideoSource{Provider: "youtube", ExternalID: "id", CanonicalURL: "https://youtu.be/id", Title: "Title"}
	for _, stage := range []string{"extract", "find", "create", "conflict lookup"} {
		t.Run(stage, func(t *testing.T) {
			findCalls := 0
			repo := stubRepository{
				find: func(context.Context, string, string) (Video, error) {
					findCalls++
					if stage == "find" || (stage == "conflict lookup" && findCalls == 2) {
						return Video{}, failure
					}
					return Video{}, ErrVideoNotFound
				},
				create: func(context.Context, Video) (Video, error) {
					if stage == "conflict lookup" {
						return Video{}, ErrSourceAlreadyExists
					}
					if stage != "create" {
						t.Fatal("unexpected Create")
					}
					return Video{}, failure
				},
			}
			provider := providerFunc(func(context.Context, string) (VideoSource, error) {
				if stage == "extract" {
					return VideoSource{}, failure
				}
				return source, nil
			})
			_, err := NewService(repo, provider).AddVideo(context.Background(), "url")
			if !errors.Is(err, failure) {
				t.Fatalf("lost error cause: %v", err)
			}
			if stage == "extract" && findCalls != 0 {
				t.Fatal("repository called after extraction failure")
			}
		})
	}
}

func TestAddVideoRejectsIncompleteSource(t *testing.T) {
	valid := VideoSource{Provider: "youtube", ExternalID: "id", CanonicalURL: "https://youtu.be/id", Title: "Title"}
	for _, field := range []string{"provider", "external ID", "canonical URL", "title"} {
		t.Run(field, func(t *testing.T) {
			source := valid
			switch field {
			case "provider":
				source.Provider = ""
			case "external ID":
				source.ExternalID = ""
			case "canonical URL":
				source.CanonicalURL = ""
			case "title":
				source.Title = ""
			}
			provider := providerFunc(func(context.Context, string) (VideoSource, error) { return source, nil })
			// Un port nil fait aussi échouer le test si la validation touche la persistance.
			if _, err := NewService(nil, provider).AddVideo(context.Background(), "url"); err == nil {
				t.Fatal("incomplete source accepted")
			}
		})
	}
}

type providerFunc func(context.Context, string) (VideoSource, error)

func (f providerFunc) Extract(ctx context.Context, url string) (VideoSource, error) {
	return f(ctx, url)
}

type stubRepository struct {
	find   func(context.Context, string, string) (Video, error)
	create func(context.Context, Video) (Video, error)
}

func (r stubRepository) FindBySource(ctx context.Context, provider, externalID string) (Video, error) {
	return r.find(ctx, provider, externalID)
}
func (r stubRepository) Create(ctx context.Context, v Video) (Video, error) { return r.create(ctx, v) }
func (r stubRepository) Get(context.Context, VideoID) (Video, error)        { panic("unexpected Get") }
