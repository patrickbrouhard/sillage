package ytdlp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestExternalDiagnosticsArePrivate(t *testing.T) {
	binary := writeExecutable(t, "echo 'HTTP Error 403: Forbidden https://secret.test/?token=PRIVATE Cookie: PRIVATE' >&2\nexit 7\n")
	source := video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}
	calls := []struct {
		name string
		run  func() error
	}{
		{"metadata", func() error {
			_, e := (Client{Binary: binary}).Extract(context.Background(), "https://youtu.be/abcdefghijk")
			return e
		}},
		{"publisher", func() error {
			_, e := (Client{Binary: binary}).ResolvePublisher(context.Background(), "https://youtube.com/@example")
			return e
		}},
		{"transcript", func() error { _, e := (Client{Binary: binary}).Fetch(context.Background(), source); return e }},
		{"download", func() error {
			_, e := (MediaClient{Binary: binary}).Download(context.Background(), source, t.TempDir())
			return e
		}},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			var failure *toolFailure
			if !errors.As(err, &failure) || failure.reason != "http_403" || failure.exitCode != 7 {
				t.Fatalf("missing safe diagnostic: %v", err)
			}
			for _, secret := range []string{"PRIVATE", "secret.test", "Cookie"} {
				if strings.Contains(err.Error(), secret) {
					t.Fatal("private output leaked")
				}
			}
		})
	}
}
