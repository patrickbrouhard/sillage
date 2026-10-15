package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func format(id, ext, vc, ac, language string, w, h int) mediaFormat {
	return mediaFormat{ID: id, Extension: ext, VideoCodec: vc, AudioCodec: ac, Language: language, Width: w, Height: h, FPS: 30, URL: "https://example.test/media"}
}

func TestMediaSelectionPolicy(t *testing.T) {
	mp4 := format("137", "mp4", "avc1.640028", "none", "", 1920, 1080)
	webm := format("248", "webm", "vp9", "none", "", 1920, 1080)
	aac := format("140", "m4a", "none", "mp4a.40.2", "en", 0, 0)
	opus := format("251", "webm", "none", "opus", "en", 0, 0)
	for _, test := range []struct {
		name    string
		formats []mediaFormat
		known   string
		want    string
		err     error
	}{
		{"equal_prefers_mp4", []mediaFormat{mp4, webm, aac, opus}, "", "mp4", nil},
		{"higher_webm", []mediaFormat{format("136", "mp4", "avc1", "none", "", 1280, 720), webm, aac, opus}, "", "webm", nil},
		{"vertical", []mediaFormat{format("v", "webm", "vp9", "none", "", 1080, 1920), opus}, "", "webm", nil},
		{"no_4k_fallback", []mediaFormat{format("v", "webm", "vp9", "none", "", 3840, 2160), opus}, "", "", media.ErrSelection},
		{"no_unknown_dimensions", []mediaFormat{format("v", "mp4", "avc1", "none", "", 0, 0), aac}, "", "", media.ErrSelection},
		{"no_mp4_opus", []mediaFormat{mp4, opus}, "", "", media.ErrSelection},
		{"ambiguous", []mediaFormat{mp4, aac, format("fr", "m4a", "none", "mp4a", "fr", 0, 0)}, "", "", media.ErrAudio},
		{"known_original", []mediaFormat{mp4, aac, format("fr", "m4a", "none", "mp4a", "fr", 0, 0)}, "en", "mp4", nil},
		{"combined", []mediaFormat{format("18", "mp4", "avc1", "mp4a", "", 640, 360)}, "", "mp4", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := chooseMedia(mediaDiscovery{Formats: test.formats}, test.known)
			if !errors.Is(err, test.err) || got.format != test.want {
				t.Fatalf("%+v %v", got, err)
			}
		})
	}
	// Un original identifié prime sur le conteneur et sur une ancienne langue enregistrée.
	opus.LanguagePreference = 10
	aac.Language = "fr"
	aac.LanguagePreference = 5
	got, err := chooseMedia(mediaDiscovery{Formats: []mediaFormat{mp4, webm, aac, opus}}, "fr")
	if err != nil || got.format != "webm" || got.audio.Language != "en" {
		t.Fatalf("%+v %v", got, err)
	}
	aac.LanguagePreference = 10
	if _, err := chooseMedia(mediaDiscovery{Formats: []mediaFormat{mp4, webm, aac, opus}}, "en"); !errors.Is(err, media.ErrAudio) {
		t.Fatal(err)
	}
}

func TestProbeRejectsIncoherentMedia(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.mp4")
	if err := os.WriteFile(path, []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	original := probeResult{Streams: []probeStream{{Type: "video", Codec: "h264", Width: 1920, Height: 1080}, {Type: "audio", Codec: "aac"}}}
	original.Format.Name = "mov,mp4,m4a,3gp,3g2,mj2"
	original.Format.Duration = "60.023"
	original.Format.Size = "8"
	for _, test := range []struct {
		name   string
		change func(*probeResult)
		stored *int64
		want   error
	}{
		{"valid", func(*probeResult) {}, nil, nil},
		{"wrong_codec", func(p *probeResult) { p.Streams[0].Codec = "hevc" }, nil, media.ErrInvalid},
		{"no_audio", func(p *probeResult) { p.Streams = p.Streams[:1] }, nil, media.ErrInvalid},
		{"4k", func(p *probeResult) { p.Streams[0].Width = 3840; p.Streams[0].Height = 2160 }, nil, media.ErrInvalid},
		{"short", func(p *probeResult) { p.Format.Duration = "40" }, nil, media.ErrDuration},
		{"audio_truncated", func(p *probeResult) { p.Streams[1].Duration = "20" }, nil, media.ErrDuration},
		{"offset", func(p *probeResult) { p.Streams[0].Start = "10" }, nil, media.ErrDuration},
		{"size", func(p *probeResult) { p.Format.Size = "100" }, nil, media.ErrInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := original
			value.Streams = append([]probeStream{}, original.Streams...)
			test.change(&value)
			data, _ := json.Marshal(value)
			_, err := validateProbe(data, path, "mp4", 60, test.stored)
			if !errors.Is(err, test.want) {
				t.Fatal(err)
			}
		})
	}
	data, _ := json.Marshal(original)
	old := int64(90000)
	if _, err := validateProbe(data, path, "mp4", 60, &old); !errors.Is(err, media.ErrDuration) {
		t.Fatal(err)
	}
}

func TestMediaCommandStopsDescendants(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "tool.sh")
	pidPath := filepath.Join(dir, "child.pid")
	content := "#!/bin/sh\ntrap '' TERM\nsh -c 'trap \"\" TERM; exec sleep 60' &\necho $! > '" + pidPath + "'\nwait\n"
	if err := os.WriteFile(script, []byte(content), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := mediaCommand(ctx, script); done <- err }()
	deadline := time.Now().Add(2 * time.Second)
	var pid int
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(pidPath); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			if pid > 0 {
				break
			}
		}
		time.Sleep(time.Millisecond)
	}
	if pid == 0 {
		cancel()
		t.Fatal("child not started")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("command did not stop")
	}
	// Un zombie réadopté attend seulement le reap de l'init WSL ; il ne travaille plus.
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err == nil && !strings.Contains(string(stat), ") Z ") {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("child still alive: %s", stat)
	}
}

// TestRealProbeContainers est déterministe et local : aucun réseau ni contenu utilisateur.
func TestRealProbeContainers(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable")
	}
	for _, container := range []string{"mp4", "webm"} {
		t.Run(container, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "media."+container)
			vc, ac := "libx264", "aac"
			if container == "webm" {
				vc, ac = "libvpx-vp9", "libopus"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_, err := mediaCommand(ctx, "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", vc, "-c:a", ac, path)
			if err != nil {
				t.Fatal(err)
			}
			data, err := mediaCommand(ctx, "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path)
			if err != nil {
				t.Fatal(err)
			}
			acquired, err := validateProbe(data, path, container, 2, nil)
			if err != nil {
				t.Fatalf("%v: %s", err, data)
			}
			t.Logf("%s: measured=%d ms, expected=2000 ms, size=%d", container, acquired.DurationMS, acquired.Size)
		})
	}
}

func TestWebMRejectsMatroskaDespiteSharedProbeDemuxer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.webm")
	for _, kind := range []string{"webm", "matroska"} {
		content := append([]byte{0x1a, 0x45, 0xdf, 0xa3, byte(0x80 + 3 + len(kind)), 0x42, 0x82, byte(0x80 + len(kind))}, []byte(kind)...)
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		if isWebM(path) != (kind == "webm") {
			t.Fatalf("wrong DocType result for %s", kind)
		}
	}
}

func TestProbeTimeoutRemainsDownloadTimeout(t *testing.T) {
	stage := t.TempDir()
	discovery := `{"id":"abcdefghijk","extractor_key":"Youtube","live_status":"not_live","duration":10,"formats":[{"format_id":"18","ext":"mp4","vcodec":"avc1","acodec":"mp4a","width":640,"height":360,"url":"https://example.test/media"}]}`
	downloader := filepath.Join(stage, "download")
	script := "#!/bin/sh\ncase \"$*\" in *--dump-single-json*) printf '%s' '" + discovery + "';; *) printf complete > '" + stage + "/media.mp4';; esac\n"
	if err := os.WriteFile(downloader, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	probe := filepath.Join(stage, "probe")
	if err := os.WriteFile(probe, []byte("#!/bin/sh\nexec sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := (MediaClient{Binary: downloader, ProbeBinary: probe}).Download(ctx, video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}, stage)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost timeout classification: %v", err)
	}
}
