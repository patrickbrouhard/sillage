package ytdlp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func format(id, ext, vc, ac, language string, w, h int) mediaFormat {
	return mediaFormat{ID: id, Extension: ext, VideoCodec: vc, AudioCodec: ac, Language: language, Width: w, Height: h, FPS: 30, URL: "https://example.test/media"}
}

func filteredDiscovery(t *testing.T, formats []mediaFormat, known string) ([]byte, error) {
	t.Helper()
	d := mediaDiscovery{ID: "abcdefghijk", Extractor: "Youtube", LiveStatus: "not_live", Duration: 60, Formats: formats}
	data, _ := json.Marshal(d)
	var raw map[string]any
	json.Unmarshal(data, &raw)
	raw["title"] = "Deterministic media"
	data, _ = json.Marshal(raw)
	return filterMediaAudio(data, d, known)
}

func TestMediaAudioIdentity(t *testing.T) {
	v := format("v", "mp4", "h264", "none", "", 1920, 1080)
	en := format("en", "m4a", "none", "aac", "en", 0, 0)
	fr := format("fr", "webm", "none", "opus", "fr", 0, 0)
	combined := format("dub", "mp4", "h264", "aac", "fr", 1920, 1080)
	for _, test := range []struct {
		name    string
		formats []mediaFormat
		known   string
		want    error
	}{
		{"ambiguous", []mediaFormat{v, en, fr}, "", media.ErrAudio},
		{"known", []mediaFormat{v, en, fr}, "en", nil},
		{"missing_original", []mediaFormat{v, fr}, "en", media.ErrSelection},
		{"one_track", []mediaFormat{v, en}, "", nil},
		{"combined_unknown", []mediaFormat{format("18", "mp4", "h264", "aac", "", 640, 360)}, "", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := filteredDiscovery(t, test.formats, test.known)
			if !errors.Is(err, test.want) {
				t.Fatal(err)
			}
		})
	}
	// Un défaut et une autre piste de même langue restent ambigus sans signal original.
	otherEn := en
	otherEn.ID = "other-en"
	otherEn.LanguagePreference = 5
	if _, err := filteredDiscovery(t, []mediaFormat{v, en, otherEn}, ""); !errors.Is(err, media.ErrAudio) {
		t.Fatal(err)
	}
	en.LanguagePreference = 10
	data, err := filteredDiscovery(t, []mediaFormat{v, en, fr, combined}, "fr")
	if err != nil {
		t.Fatal(err)
	}
	var d mediaDiscovery
	json.Unmarshal(data, &d)
	if len(d.Formats) != 2 || d.Formats[1].ID != "en" {
		t.Fatalf("%s", data)
	}
	fr.LanguagePreference = 10
	if _, err := filteredDiscovery(t, []mediaFormat{v, en, fr}, ""); !errors.Is(err, media.ErrAudio) {
		t.Fatal(err)
	}
}

// TestNativeMediaSelection exerce le véritable sélecteur sur des métadonnées locales, sans réseau.
func TestNativeMediaSelection(t *testing.T) {
	binary, err := exec.LookPath("yt-dlp")
	if err != nil {
		t.Skip("yt-dlp unavailable")
	}
	audio := format("a", "m4a", "none", "aac", "en", 0, 0)
	audio.LanguagePreference = 10
	for _, test := range []struct {
		name   string
		videos []mediaFormat
		want   string
	}{
		{"prefer_1080", []mediaFormat{format("720", "mp4", "h264", "none", "", 1280, 720), format("1080", "webm", "vp9", "none", "", 1920, 1080), format("2160", "mp4", "av1", "none", "", 3840, 2160)}, "1080"},
		{"vertical", []mediaFormat{format("720", "mp4", "h264", "none", "", 720, 1280), format("1080", "webm", "vp9", "none", "", 1080, 1920)}, "1080"},
		{"higher_fallback", []mediaFormat{format("1440", "webm", "vp9", "none", "", 2560, 1440), format("2160", "mp4", "av1", "none", "", 3840, 2160)}, "1440"},
		{"combined_dub_excluded", []mediaFormat{format("v", "mp4", "h264", "none", "", 1280, 720), format("dub", "mp4", "h264", "aac", "fr", 1920, 1080)}, "v"},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := filteredDiscovery(t, append(test.videos, audio), "")
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "info.json")
			os.WriteFile(path, data, 0600)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			output, err := mediaCommand(ctx, binary, "--ignore-config", "--no-cache-dir", "--simulate", "--dump-single-json", "--load-info-json", path, "-S", "res:1080", "-f", "bv*+ba/b")
			if err != nil {
				t.Fatal(err)
			}
			var selected struct {
				Formats []mediaFormat `json:"requested_formats"`
			}
			if err := json.Unmarshal(output, &selected); err != nil {
				t.Fatal(err)
			}
			if len(selected.Formats) != 2 || selected.Formats[0].ID != test.want || selected.Formats[1].ID != "a" {
				t.Fatalf("%s", output)
			}
		})
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
		{"additional_codec", func(p *probeResult) { p.Streams[0].Codec = "hevc" }, nil, nil},
		{"no_audio", func(p *probeResult) { p.Streams = p.Streams[:1] }, nil, media.ErrInvalid},
		{"4k", func(p *probeResult) { p.Streams[0].Width = 3840; p.Streams[0].Height = 2160 }, nil, nil},
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
	for _, container := range []string{"mp4", "webm", "mkv", "mov"} {
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
	script := "#!/bin/sh\ncase \"$*\" in *--dump-single-json*) printf '%s' '" + discovery + "';; *) printf complete > '" + stage + "/media.mp4'; printf '\"%s\"' '" + stage + "/media.mp4';; esac\n"
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

// TestUnavailableOriginalNeverReextracts couvre le repli implicite de --load-info-json.
func TestUnavailableOriginalNeverReextracts(t *testing.T) {
	binary, err := exec.LookPath("yt-dlp")
	if err != nil {
		t.Skip("yt-dlp unavailable")
	}
	var forbidden atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/original" {
			forbidden.Add(1)
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	original := format("18", "mp4", "h264", "aac", "en", 640, 360)
	original.LanguagePreference = 10
	original.URL = server.URL + "/original"
	dub := format("dub", "mp4", "h264", "aac", "fr", 1920, 1080)
	dub.URL = server.URL + "/dub"
	d := mediaDiscovery{ID: "abcdefghijk", Type: "video", Extractor: "Youtube", Duration: 60, LiveStatus: "not_live", Formats: []mediaFormat{original, dub}}
	data, _ := json.Marshal(d)
	var raw map[string]any
	json.Unmarshal(data, &raw)
	raw["title"] = "Unavailable original"
	raw["webpage_url"] = server.URL + "/fallback"
	raw["url"] = dub.URL
	data, _ = json.Marshal(raw)
	data, err = filterMediaAudio(data, d, "")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "info.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err = mediaCommand(ctx, binary, "--ignore-config", "--no-cache-dir", "--load-info-json", path,
		"--no-simulate", "--retries", "0", "--socket-timeout", "2", "-S", "res:1080", "-f", "bv*+ba/b", "-o", filepath.Join(dir, "media.%(ext)s"))
	if err == nil {
		t.Fatal("unavailable original succeeded")
	}
	if forbidden.Load() != 0 {
		t.Fatal("audio policy bypassed through reextraction or dub")
	}
}
