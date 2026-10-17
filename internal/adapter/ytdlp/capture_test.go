package ytdlp

import (
	"context"
	"errors"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

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
	}{{0, 0}, {900, 0}, {1100, 1}, {1500, 1}, {2100, 2}, {2800, 2}} {
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
