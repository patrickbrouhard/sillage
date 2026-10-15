package ytdlp

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

// TestYouTubeMediaIntegration exige une activation explicite ; la suite normale reste hors réseau.
func TestYouTubeMediaIntegration(t *testing.T) {
	id := os.Getenv("SILLAGE_TEST_YOUTUBE_ID")
	if id == "" {
		t.Skip("set SILLAGE_TEST_YOUTUBE_ID for an explicit network test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	result, err := (MediaClient{}).Download(ctx, video.VideoSource{Provider: "youtube", ExternalID: id}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("YouTube %s: format=%s duration=%d ms size=%d bytes", id, result.Format, result.DurationMS, result.Size)
}
