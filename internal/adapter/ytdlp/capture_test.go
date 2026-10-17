package ytdlp

import (
	"context"
	"errors"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestCaptureAccurateSeekBetweenKeyframes(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	root := t.TempDir()
	input := filepath.Join(root, "long-gop.mp4")
	// Trois couleurs d'une seconde ; une seule image clé pour les trois secondes.
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=64x48:r=10:d=1", "-f", "lavfi", "-i", "color=lime:s=64x48:r=10:d=1", "-f", "lavfi", "-i", "color=blue:s=64x48:r=10:d=1", "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-g", "300", "-keyint_min", "300", "-sc_threshold", "0", input)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	for _, test := range []struct {
		ms      int64
		channel int
	}{{0, 0}, {900, 0}, {950, 1}, {999, 1}, {1950, 2}, {1100, 1}, {1500, 1}, {2100, 2}, {2800, 2}} {
		stage := t.TempDir()
		if err := (CaptureClient{}).Extract(context.Background(), video.VideoSource{}, input, test.ms, stage); err != nil {
			t.Fatalf("%d: %v", test.ms, err)
		}
		f, err := os.Open(filepath.Join(stage, "frame.png"))
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		r, g, b, _ := img.At(32, 24).RGBA()
		values := []uint32{r, g, b}
		if values[test.channel] < 60000 {
			t.Fatalf("%d: rgb=%v", test.ms, values)
		}
		for i, v := range values {
			if i != test.channel && v > 3000 {
				t.Fatalf("%d: rgb=%v", test.ms, values)
			}
		}
		if img.Bounds().Dx() != 64 || img.Bounds().Dy() != 48 {
			t.Fatal("resized")
		}
	}
	if err := (CaptureClient{}).Extract(context.Background(), video.VideoSource{}, input, 3000, t.TempDir()); !errors.Is(err, asset.ErrExtract) {
		t.Fatalf("end: %v", err)
	}
}

func TestCaptureStorageFailureIsNotFallbackEligible(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	input := filepath.Join(t.TempDir(), "frame.mkv")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=32x32:d=1", "-c:v", "ffv1", input).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	err := (CaptureClient{}).Extract(context.Background(), video.VideoSource{}, input, 0, filepath.Join(t.TempDir(), "absent"))
	if err == nil || errors.Is(err, asset.ErrExtract) {
		t.Fatalf("storage error: %v", err)
	}
}

func TestCaptureHDRAndNonSquarePixels(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	root := t.TempDir()
	hdr := filepath.Join(root, "hdr.mkv")
	args := []string{"-v", "error", "-f", "lavfi", "-i", "color=gray:s=64x48:r=10:d=1", "-vf", "format=yuv420p10le", "-c:v", "ffv1", "-color_trc", "smpte2084", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", hdr}
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if err := (CaptureClient{}).Extract(context.Background(), video.VideoSource{}, hdr, 100, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	anamorphic := filepath.Join(root, "anamorphic.mkv")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=64x48:d=1", "-vf", "setsar=2/1", "-c:v", "ffv1", anamorphic).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if err := (CaptureClient{}).Extract(context.Background(), video.VideoSource{}, anamorphic, 0, t.TempDir()); !errors.Is(err, asset.ErrExtract) {
		t.Fatalf("non-square: %v", err)
	}
}

func TestCaptureUnavailableToolDoesNotTriggerRemoteFallback(t *testing.T) {
	err := (CaptureClient{ProbeBinary: filepath.Join(t.TempDir(), "absent")}).Extract(context.Background(), video.VideoSource{}, "input", 0, t.TempDir())
	if err == nil || errors.Is(err, asset.ErrExtract) {
		t.Fatalf("tool failure: %v", err)
	}
}

// TestCaptureYouTubeIntegration reste volontaire : la CI ne dépend jamais de YouTube.
func TestCaptureYouTubeIntegration(t *testing.T) {
	if os.Getenv("SILLAGE_CAPTURE_YOUTUBE_TEST") != "1" {
		t.Skip("explicit YouTube test disabled")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()
	stage := t.TempDir()
	source := video.VideoSource{Provider: "youtube", ExternalID: "jNQXAC9IVRw"}
	if err := (CaptureClient{}).Extract(ctx, source, "", 1500, stage); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(stage, "frame.png"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, err := png.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("remote PNG %dx%d at 1500 ms", cfg.Width, cfg.Height)
}
