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
		if _, err := s.Save(context.Background(), id, "", 0); !errors.Is(err, video.ErrInvalidInput) {
			t.Fatal(err)
		}
	}
	if _, err := s.Save(context.Background(), 1, "\xff", 0); !errors.Is(err, video.ErrInvalidInput) {
		t.Fatal(err)
	}
}

func TestServiceNormalizesOnlyLineEndingsAndPreservesRepositoryErrors(t *testing.T) {
	failure := errors.New("persistence failed")
	for _, pair := range [][2]string{
		{"", ""},
		{"  # Café\n\ttexte  \n", "  # Café\n\ttexte  \n"},
		{"  # Café\r\n\ttexte  \nfin\r\r\n", "  # Café\n\ttexte  \nfin\n\n"},
	} {
		r := repositoryStub{t: t, content: pair[1], failure: failure}
		s := NewService(r)
		if _, err := s.Save(context.Background(), 7, pair[0], 0); !errors.Is(err, failure) {
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

func (r repositoryStub) Save(_ context.Context, id video.VideoID, content string, expectedRevision int64, at time.Time) (SaveResult, error) {
	if expectedRevision != 0 || id != 7 || content != r.content || at.IsZero() || at.Location() != time.UTC || at.Nanosecond()%1_000_000 != 0 {
		r.t.Fatalf("unexpected save: %d %q %v", id, content, at)
	}
	return SaveResult{}, r.failure
}
