package ytdlp

import (
	"context"
	"errors"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFetchTranscriptWithExecutable(t *testing.T) {
	temporary := t.TempDir()
	t.Setenv("TMPDIR", temporary)
	fixture, err := filepath.Abs("testdata/captions.json3")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAPTION_FIXTURE", fixture)
	discovery := filepath.Join(t.TempDir(), "discovery.json")
	t.Setenv("DISCOVERY_FIXTURE", discovery)
	if err := os.WriteFile(discovery, []byte(`{"extractor_key":"Youtube","id":"abc","title":"Test","automatic_captions":{"en-orig":[{"ext":"json3","url":"https://example.test/en"}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	binary := writeExecutable(t, `
for arg in "$@"; do
 if [ "$arg" = "--dump-single-json" ]; then
  cat "$DISCOVERY_FIXTURE"
  exit 0
 fi
done
while [ "$#" -gt 0 ]; do
 case "$1" in
 --output) output="$2"; shift ;;
 --sub-langs) test "$2" = "^en-orig$" || exit 8; shift ;;
 --load-info-json) cmp "$2" "$DISCOVERY_FIXTURE" || exit 9; shift ;;
 esac
 shift
done
test -n "$output" || exit 10
cp "$CAPTION_FIXTURE" "$(dirname "$output")/caption.en-orig.json3"
`)
	source := video.VideoSource{Provider: "youtube", ExternalID: "abc"}
	got, err := (Client{Binary: binary}).Fetch(context.Background(), source)
	if err != nil || got.Language != "en" || got.Content.PlainText() != "This is useful. Été — bonjour !" {
		t.Fatalf("%#v %v", got, err)
	}
	entries, err := os.ReadDir(temporary)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary files remain: %v %v", entries, err)
	}
	bad := filepath.Join(t.TempDir(), "invalid")
	if err := os.WriteFile(bad, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAPTION_FIXTURE", bad)
	if _, err := (Client{Binary: binary}).Fetch(context.Background(), source); !errors.Is(err, transcript.ErrFetchFailed) {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(temporary)
	if len(entries) != 0 {
		t.Fatal("failed acquisition leaked temporary files")
	}
}

func TestTranscriptProcessErrors(t *testing.T) {
	source := video.VideoSource{Provider: "youtube", ExternalID: "abc"}
	for _, tc := range []struct {
		name, script string
		timeout      bool
	}{
		{"exit", "echo private-diagnostic >&2; exit 3", false},
		{"invalid discovery", "echo null", false},
		{"timeout", "exec sleep 30", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err := (Client{Binary: writeExecutable(t, tc.script)}).Fetch(ctx, source)
			want := transcript.ErrFetchFailed
			if tc.timeout {
				want = context.DeadlineExceeded
			}
			if !errors.Is(err, want) {
				t.Fatalf("%v", err)
			}
		})
	}
	missing := Client{Binary: filepath.Join(t.TempDir(), "missing")}
	if _, err := missing.Fetch(context.Background(), source); !errors.Is(err, os.ErrNotExist) || errors.Is(err, transcript.ErrFetchFailed) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := missing.Fetch(ctx, source); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
