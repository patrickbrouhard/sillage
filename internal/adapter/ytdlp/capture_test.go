package ytdlp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/logging"
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

	for _, target := range []struct {
		id string
		ms int64
	}{
		{"jNQXAC9IVRw", 1500},
		{"uJMjlKksSks", 120000},
		{"uJMjlKksSks", 73479},
		{"CcsgednSRfE", 301000},
		{"G2B0YWuJUgI", 95140},
	} {
		t.Run(target.id, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			stage := t.TempDir()
			source := video.VideoSource{Provider: "youtube", ExternalID: target.id}
			if err := (CaptureClient{}).Extract(ctx, source, "", target.ms, stage); err != nil {
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
			t.Logf("remote PNG %dx%d at %d ms", cfg.Width, cfg.Height, target.ms)
		})
	}

}

// TestCaptureDiagnosticsNeverExposePrivateOutput vérifie les erreurs et les logs réels.
func TestCaptureDiagnosticsNeverExposePrivateOutput(t *testing.T) {
	for _, tc := range []struct{ stage, detail, want string }{
		{"resolve", "HTTP Error 403: Forbidden", "http_403"},
		{"probe", "Invalid data found when processing input", "invalid_media"},
		{"decode", "Resource temporarily unavailable", "resource_unavailable"},
		{"decode", "arbitrary failure", "tool_failed"},
	} {
		t.Run(tc.stage+"_"+tc.want, func(t *testing.T) {
			script := writeExecutable(t, "#!/bin/sh\nprintf '%s\\n' '"+tc.detail+" https://secret.test/signed?token=PRIVATE Cookie: PRIVATE Authorization: PRIVATE' >&2\nexit 1\n")
			var logs bytes.Buffer
			logger, _ := logging.New(&logs, "DEBUG", "json")
			_, err := captureCommand(logging.WithLogger(context.Background(), logger), tc.stage, script)
			if !errors.Is(err, asset.ErrExtract) || !strings.Contains(err.Error(), "stage="+tc.stage) || !strings.Contains(err.Error(), "reason="+tc.want) {
				t.Fatalf("unexpected error: %v", err)
			}
			combined := err.Error() + logs.String()
			for _, secret := range []string{"PRIVATE", "secret.test", "Cookie", "Authorization", "https:"} {
				if strings.Contains(combined, secret) {
					t.Fatalf("private output leaked")
				}
			}
		})
	}
}

// TestCaptureHTTPSLateSeek exerce Range, le probe et le décodage loin du début,
// avec des changements de couleur après l'image clé précédente.
func TestCaptureHTTPSLateSeek(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	input := filepath.Join(t.TempDir(), "long.mp4")
	args := []string{
		"-v", "error", "-f", "lavfi", "-i", "color=red:s=64x48:r=10:d=119.8",
		"-f", "lavfi", "-i", "color=lime:s=64x48:r=10:d=181",
		"-f", "lavfi", "-i", "color=blue:s=64x48:r=10:d=3.2",
		"-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
		"-map", "[v]", "-c:v", "libx264", "-g", "3000", "-keyint_min", "3000",
		"-sc_threshold", "0", "-movflags", "+faststart", input,
	}
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	var ranges atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			ranges.Add(1)
		}
		http.ServeFile(w, r, input)
	}))
	defer server.Close()
	metadata, _ := json.Marshal(map[string]any{
		"id": "abcdefghijk", "extractor_key": "Youtube", "live_status": "not_live",
		"protocol": "https", "width": 64, "height": 48, "url": server.URL + "/long.mp4",
	})
	resolver := writeExecutable(t, "#!/bin/sh\nprintf '%s' '"+string(metadata)+"'\n")
	for _, target := range []struct {
		ms      int64
		channel int
	}{{120050, 1}, {301050, 2}} {
		stage := t.TempDir()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := (CaptureClient{Binary: resolver}).Extract(ctx, video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}, "", target.ms, stage)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		file, err := os.Open(filepath.Join(stage, "frame.png"))
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		r, g, b, _ := img.At(32, 24).RGBA()
		if []uint32{r, g, b}[target.channel] < 60000 {
			t.Fatalf("old frame at %d: %d %d %d", target.ms, r, g, b)
		}
	}
	if ranges.Load() == 0 {
		t.Fatal("no HTTP range requests")
	}
}

// TestCaptureRenewsRejectedURLOnce borne le renouvellement et ne réessaie pas les autres échecs.
func TestCaptureRenewsRejectedURLOnce(t *testing.T) {
	for _, tc := range []struct {
		name, detail string
		recover      bool
		calls        int
	}{
		{"renewed", "HTTP error 403 Forbidden", true, 2},
		{"still_rejected", "HTTP error 403 Forbidden", false, 2},
		{"invalid_media", "Invalid data found", false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			count := filepath.Join(root, "resolutions")
			metadata := `{"id":"abcdefghijk","extractor_key":"Youtube","live_status":"not_live","protocol":"https","url":"https://private.test/signed"}`
			resolver := writeExecutable(t, "#!/bin/sh\necho x >> '"+count+"'\nprintf '%s' '"+metadata+"'\n")
			probeScript := "#!/bin/sh\n"
			if tc.recover {
				probeJSON := `{"streams":[{"codec_name":"h264"}],"format":{"duration":"500"}}`
				probeScript += "if [ -f '" + filepath.Join(root, "rejected") + "' ]; then printf '%s' '" + probeJSON + "'; exit 0; fi\ntouch '" + filepath.Join(root, "rejected") + "'\n"
			}
			probeScript += "echo '" + tc.detail + " https://private.test/?token=PRIVATE' >&2\nexit 1\n"
			probe := writeExecutable(t, probeScript)
			decoder := writeExecutable(t, "#!/bin/sh\nprintf 'decoded-frame'\n")
			err := (CaptureClient{Binary: resolver, ProbeBinary: probe, FFmpegBinary: decoder}).Extract(context.Background(), video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}, "", 301000, root)
			if (err == nil) != tc.recover {
				t.Fatalf("unexpected result: %v", err)
			}
			data, readErr := os.ReadFile(count)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if strings.Count(string(data), "x") != tc.calls {
				t.Fatalf("unbounded or missing retry: %s", data)
			}
			if err != nil && strings.Contains(err.Error(), "PRIVATE") {
				t.Fatal("secret leaked")
			}
		})
	}
}

// TestCaptureHLSFallbackBoundaries reproduit une sortie vide du seek HLS sans dépendre de YouTube.
func TestCaptureHLSFallbackBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name       string
		width      int
		protocol   string
		decodeExit bool
		wantCalls  int
		success    bool
	}{
		{"same_resolution", 1920, "https", false, 2, true},
		{"alternative_probe_403_renewed", 1920, "https", false, 3, true},
		{"smaller_refused", 1280, "https", false, 2, false},
		{"hls_refused", 1920, "m3u8_native", false, 2, false},
		{"alternative_403_bounded", 1920, "https", true, 3, false},
		{"renewal_budget_shared", 1920, "https", true, 3, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			calls := filepath.Join(root, "calls")
			first := map[string]any{"id": "abcdefghijk", "extractor_key": "Youtube", "live_status": "not_live",
				"protocol": "m3u8_native", "width": 1920, "height": 1080, "url": "https://private.test/hls"}
			second := map[string]any{"id": "abcdefghijk", "extractor_key": "Youtube", "live_status": "not_live",
				"protocol": tc.protocol, "width": tc.width, "height": 1080, "url": "https://private.test/direct"}
			a, _ := json.Marshal(first)
			b, _ := json.Marshal(second)
			script := "#!/bin/sh\nif [ -f '" + calls + "' ]; then\n"
			// Vérifie le sélecteur exact transmis au véritable point d'entrée yt-dlp.
			if tc.name == "renewal_budget_shared" {
				script += "if [ ! -f '" + filepath.Join(root, "renewed") + "' ]; then touch '" + filepath.Join(root, "renewed") + "'; echo renewed >> '" + calls + "'; printf '%s' '" + string(a) + "'; exit 0; fi\n"
			}
			script += "case \"$*\" in *'bv*[protocol=https][width=1920][height=1080]'*) ;; *) exit 9 ;; esac\n"
			script += "echo retry >> '" + calls + "'\nprintf '%s' '" + string(b) + "'\nelse\necho first > '" + calls + "'\nprintf '%s' '" + string(a) + "'\nfi\n"
			resolver := writeExecutable(t, script)
			probeJSON := `{"streams":[{"codec_name":"h264"}],"format":{"duration":"500"}}`
			probeScript := "#!/bin/sh\n"
			if tc.name == "alternative_probe_403_renewed" {
				probeScript += "case \"$*\" in *'/direct'*) if [ ! -f '" + filepath.Join(root, "refused") + "' ]; then touch '" + filepath.Join(root, "refused") + "'; echo '403 Forbidden' >&2; exit 1; fi ;; esac\n"
			}
			if tc.name == "renewal_budget_shared" {
				probeScript += "case \"$*\" in *'/hls'*) if [ ! -f '" + filepath.Join(root, "refused") + "' ]; then touch '" + filepath.Join(root, "refused") + "'; echo '403 Forbidden' >&2; exit 1; fi ;; esac\n"
			}
			probeScript += "printf '%s' '" + probeJSON + "'\n"
			probe := writeExecutable(t, probeScript)
			decoderScript := "#!/bin/sh\ncase \"$*\" in *'/hls'*) exit 0 ;; esac\n"
			if tc.decodeExit {
				decoderScript += "echo '403 Forbidden PRIVATE' >&2\nexit 1\n"
			} else {
				decoderScript += "printf 'frame'\n"
			}
			decoder := writeExecutable(t, decoderScript)
			err := (CaptureClient{Binary: resolver, ProbeBinary: probe, FFmpegBinary: decoder}).Extract(context.Background(), video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}, "", 120000, root)
			if (err == nil) != tc.success {
				t.Fatalf("unexpected result: %v", err)
			}
			data, readErr := os.ReadFile(calls)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if strings.Count(string(data), "\n") != tc.wantCalls {
				t.Fatalf("unexpected attempts: %s", data)
			}
			if !tc.success {
				if _, err := os.Stat(filepath.Join(root, "frame.png")); !os.IsNotExist(err) {
					t.Fatal("failed capture wrote image")
				}
			}
		})
	}
}

// TestCaptureNativeTransportSelection exerce les arguments de production avec le vrai
// sélecteur yt-dlp sur des formats synthétiques, sans connexion à YouTube.
func TestCaptureNativeTransportSelection(t *testing.T) {
	binary, err := exec.LookPath("yt-dlp")
	if err != nil {
		t.Skip("yt-dlp unavailable")
	}
	makeFormat := func(id, protocol string, width, height, preference int) map[string]any {
		return map[string]any{
			"format_id": id, "url": "https://example.test/" + id, "protocol": protocol,
			"width": width, "height": height, "vcodec": "h264", "acodec": "none",
			"ext": "mp4", "fps": 30, "preference": preference, "quality": preference,
		}
	}
	for _, tc := range []struct {
		name    string
		formats []map[string]any
		want    string
	}{
		{"equal_dimensions_override_extractor_preference", []map[string]any{
			makeFormat("hls", "m3u8_native", 1920, 1080, 10),
			makeFormat("direct", "https", 1920, 1080, -1)}, "direct"},
		{"higher_hls_preserved", []map[string]any{
			makeFormat("hls4k", "m3u8_native", 3840, 2160, 0),
			makeFormat("direct", "https", 1920, 1080, 10)}, "hls4k"},
		{"higher_https_preserved", []map[string]any{
			makeFormat("hls", "m3u8_native", 1920, 1080, 10),
			makeFormat("direct4k", "https", 3840, 2160, 0)}, "direct4k"},
		{"hls_only", []map[string]any{makeFormat("hls", "m3u8_native", 1920, 1080, 0)}, "hls"},
		{"portrait", []map[string]any{
			makeFormat("hls", "m3u8_native", 1080, 1920, 10),
			makeFormat("direct", "https", 1080, 1920, 0)}, "direct"},
		{"different_width_not_equal_resolution", []map[string]any{
			makeFormat("wide", "m3u8_native", 2048, 1080, 0),
			makeFormat("direct", "https", 1920, 1080, 0)}, "wide"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Un format audio favorisé ne doit pas gagner malgré --format-sort-force.
			audio := map[string]any{"format_id": "audio", "url": "https://example.test/audio",
				"protocol": "https", "ext": "m4a", "vcodec": "none", "acodec": "aac", "preference": 100}
			data, err := json.Marshal(map[string]any{
				"id": "abcdefghijk", "extractor_key": "Youtube", "live_status": "not_live",
				"title": "Synthetic capture", "formats": append(tc.formats, audio),
			})
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "info.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			args := captureRemoteArgs("abcdefghijk", "bv*")
			// Remplacer seulement l'acquisition réseau ; conserver sélection, tri et sortie réels.
			args = append(args[:len(args)-2], "--load-info-json", path)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			result, err := mediaCommand(ctx, binary, args...)
			if err != nil {
				t.Fatal(err)
			}
			var selected captureInput
			if err := json.Unmarshal(result, &selected); err != nil {
				t.Fatal(err)
			}
			if selected.URL != "https://example.test/"+tc.want {
				t.Fatalf("selected %s, want %s", selected.URL, tc.want)
			}
		})
	}
}

// TestCaptureValidationDoesNotRetryHLS sépare les diagnostics des décisions de repli.
func TestCaptureValidationDoesNotRetryHLS(t *testing.T) {
	for _, tc := range []struct {
		name, probe, reason string
	}{
		{"pixels", `{"streams":[{"codec_name":"h264","sample_aspect_ratio":"2:1"}],"format":{"duration":"500"}}`, "non_square_pixels"},
		{"timestamp", `{"streams":[{"codec_name":"h264"}],"format":{"duration":"1"}}`, "timestamp_beyond_final_frame"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			calls := filepath.Join(root, "calls")
			resolver := writeExecutable(t, "#!/bin/sh\necho call >> '"+calls+"'\nprintf '%s' '"+`{"id":"abcdefghijk","extractor_key":"Youtube","live_status":"not_live","protocol":"m3u8_native","width":1920,"height":1080,"url":"https://private.test/hls"}`+"'\n")
			probe := writeExecutable(t, "#!/bin/sh\nprintf '%s' '"+tc.probe+"'\n")
			var output bytes.Buffer
			logger, _ := logging.New(&output, "DEBUG", "json")
			ctx := logging.WithLogger(context.Background(), logger)
			err := (CaptureClient{Binary: resolver, ProbeBinary: probe}).Extract(
				ctx, video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}, "", 2000, root,
			)
			if !errors.Is(err, asset.ErrExtract) || !captureReason(err, tc.reason) {
				t.Fatalf("unexpected validation: %v", err)
			}
			data, readErr := os.ReadFile(calls)
			if readErr != nil || strings.Count(string(data), "\n") != 1 {
				t.Fatalf("unexpected resolution attempts: %q, %v", data, readErr)
			}
			logger.Error("failed", logging.Error(err))
			if !strings.Contains(output.String(), tc.reason) || strings.Contains(output.String(), "private.test") {
				t.Fatal(output.String())
			}
		})
	}
}
