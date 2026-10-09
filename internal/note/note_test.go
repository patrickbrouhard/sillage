package note

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestServiceValidationWithoutHTTP(t *testing.T) {
	s := NewService(nil)
	for _, id := range []video.VideoID{0, -1} {
		if _, err := s.Get(context.Background(), id); !errors.Is(err, video.ErrInvalidInput) {
			t.Fatal(err)
		}
		if _, err := s.Save(context.Background(), id, ""); !errors.Is(err, video.ErrInvalidInput) {
			t.Fatal(err)
		}
	}
	if _, err := s.Save(context.Background(), 1, "\xff"); !errors.Is(err, video.ErrInvalidInput) {
		t.Fatal(err)
	}
}

func TestServicePreservesContentAndRepositoryErrors(t *testing.T) {
	failure := errors.New("persistence failed")
	for _, content := range []string{"", "  # Café\r\n\ttexte  \n"} {
		r := repositoryStub{t: t, content: content, failure: failure}
		s := NewService(r)
		if _, err := s.Save(context.Background(), 7, content); !errors.Is(err, failure) {
			t.Fatal(err)
		}
		if _, err := s.Get(context.Background(), 7); !errors.Is(err, failure) {
			t.Fatal(err)
		}
	}
}

type repositoryStub struct {
	t       *testing.T
	content string
	failure error
}

func (r repositoryStub) Get(_ context.Context, id video.VideoID) (Note, error) {
	if id != 7 {
		r.t.Fatal(id)
	}
	return Note{}, r.failure
}

func (r repositoryStub) Save(_ context.Context, id video.VideoID, content string, at time.Time) (SaveResult, error) {
	if id != 7 || content != r.content || at.IsZero() || at.Location() != time.UTC || at.Nanosecond()%1_000_000 != 0 {
		r.t.Fatalf("unexpected save: %d %q %v", id, content, at)
	}
	return SaveResult{}, r.failure
}
