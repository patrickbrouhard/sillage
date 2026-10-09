package video

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestTagIdentity(t *testing.T) {
	for _, tc := range []struct {
		left, right string
		equal       bool
	}{
		{"DevOps", "devops", true}, {"École", "école", true},
		{"Café", "Cafe\u0301", true}, {"Café", "Cafe", false},
		{"Go", "Golang", false}, {" Go\u00a0", "go", true},
		{"Straße", "STRASSE", true}, {"Σ", "ς", true},
		{"Ｇｏ", "Go", false},
	} {
		t.Run(tc.left+"/"+tc.right, func(t *testing.T) {
			a, err := NormalizeTagName(tc.left)
			if err != nil {
				t.Fatal(err)
			}
			b, err := NormalizeTagName(tc.right)
			if err != nil || (a.Key == b.Key) != tc.equal {
				t.Fatalf("%#v / %#v: %v", a, b, err)
			}
			if a.Name != strings.TrimSpace(tc.left) {
				t.Fatal("display changed")
			}
		})
	}
}

func TestTagValidationBeforePersistence(t *testing.T) {
	s := NewTagService(nil)
	for _, names := range [][]string{nil, {}, {"Go", " "}, {"\xff"}, {strings.Repeat("é", 201)}} {
		if _, err := s.Add(context.Background(), 1, names); !errors.Is(err, ErrInvalidInput) {
			t.Fatal(err)
		}
	}
	if _, err := s.Add(context.Background(), 0, []string{"Go"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	if err := s.Remove(context.Background(), 1, 0); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	if _, err := NormalizeTagName(strings.Repeat("é", 200)); err != nil {
		t.Fatal(err)
	}
}
