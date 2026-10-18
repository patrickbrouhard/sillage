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

// Ces données synthétiques sont réservées aux tests du sélecteur natif.
type mediaFormat struct {
	ID                 string  `json:"format_id"`
	Extension          string  `json:"ext"`
	VideoCodec         string  `json:"vcodec"`
	AudioCodec         string  `json:"acodec"`
	Width              int     `json:"width"`
	Height             int     `json:"height"`
	FPS                float64 `json:"fps"`
	Language           string  `json:"language"`
	LanguagePreference int     `json:"language_preference"`
	URL                string  `json:"url"`
}

func format(id, ext, vc, ac, language string, w, h int) mediaFormat {
	return mediaFormat{ID: id, Extension: ext, VideoCodec: vc, AudioCodec: ac, Language: language, Width: w, Height: h, FPS: 30, URL: "https://example.test/media"}
}

func nativeDiscovery(t *testing.T, formats []mediaFormat) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"id": "abcdefghijk", "extractor_key": "Youtube", "live_status": "not_live",
		"duration": 60, "formats": formats, "title": "Deterministic media",
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
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
		{"combined_dub_accepted", []mediaFormat{format("v", "mp4", "h264", "none", "", 1280, 720), format("dub", "mp4", "h264", "aac", "fr", 1920, 1080)}, "dub"},
	} {
		t.Run(test.name, func(t *testing.T) {
			data := nativeDiscovery(t, append(test.videos, audio))
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
				ID      string        `json:"format_id"`
			}
			if err := json.Unmarshal(output, &selected); err != nil {
				t.Fatal(err)
			}
			if selected.ID != test.want && (len(selected.Formats) != 2 || selected.Formats[0].ID != test.want || selected.Formats[1].ID != "a") {
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
	// SIGKILL est asynchrone : attendre aussi l'arrêt du descendant, pas seulement du parent.
	// Un zombie réadopté attend seulement sa collecte par init ; il ne travaille plus.
	deadline = time.Now().Add(2 * time.Second)
	for {
		stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if errors.Is(err, os.ErrNotExist) || (err == nil && strings.Contains(string(stat), ") Z ")) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if !time.Now().Before(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("child still alive: %s", stat)
		}
		time.Sleep(5 * time.Millisecond)
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
	output := "source:{\"id\":\"abcdefghijk\",\"extractor_key\":\"Youtube\",\"live_status\":\"not_live\"}\n" +
		"result:{\"file\":{\"id\":\"abcdefghijk\",\"extractor_key\":\"Youtube\",\"live_status\":\"not_live\",\"acodec\":\"aac\",\"filepath\":\"" + stage + "/media.mp4\"},\"tracks\":[]}\n"
	downloader := filepath.Join(stage, "download")
	script := "#!/bin/sh\nprintf complete > '" + stage + "/media.mp4'\nprintf '%s' '" + output + "'\n"
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

// TestNativeAcquisitionProtocol exerce filtres, assemblage et projections JSON du vrai
// exécutable avec des octets synthétiques locaux ; aucune dépendance à YouTube.
func TestNativeAcquisitionProtocol(t *testing.T) {
	for _, tool := range []string{"yt-dlp", "ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dir := t.TempDir()
	full := filepath.Join(dir, "combined.mp4")
	if _, err := mediaCommand(ctx, "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-c:a", "aac", full); err != nil {
		t.Fatal(err)
	}
	for _, part := range []struct{ name, flag string }{{"video.mp4", "-an"}, {"audio.m4a", "-vn"}} {
		if _, err := mediaCommand(ctx, "ffmpeg", "-v", "error", "-i", full, part.flag, "-c", "copy", filepath.Join(dir, part.name)); err != nil {
			t.Fatal(err)
		}
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.ServeFile(w, r, filepath.Join(dir, filepath.Base(r.URL.Path)))
	}))
	defer server.Close()
	for _, test := range []struct {
		name, status, id string
		split            bool
		want             error
	}{
		{"combined", "not_live", "abcdefghijk", false, nil},
		{"split", "was_live", "abcdefghijk", true, nil},
		{"live", "is_live", "abcdefghijk", false, media.ErrUnfinished},
		{"upcoming", "is_upcoming", "abcdefghijk", false, media.ErrUnfinished},
		{"processing", "post_live", "abcdefghijk", false, media.ErrUnfinished},
		{"unknown", "", "abcdefghijk", false, media.ErrUnfinished},
		{"wrong_identity", "not_live", "wrongid1234", false, media.ErrInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			stage := t.TempDir()
			combined := format("combined", "mp4", "h264", "aac", "fr-FR", 320, 180)
			combined.URL = server.URL + "/combined.mp4"
			formats := []mediaFormat{combined}
			if test.split {
				v := format("v", "mp4", "h264", "none", "de", 320, 180)
				a := format("a", "m4a", "none", "aac", "en-US", 0, 0)
				v.URL, a.URL = server.URL+"/video.mp4", server.URL+"/audio.m4a"
				formats = []mediaFormat{v, a}
			}
			data, _ := json.Marshal(map[string]any{
				"id": test.id, "extractor_key": "Youtube", "live_status": test.status,
				"title": "Synthetic", "formats": formats,
				// La durée distante manque volontairement.
			})
			input := filepath.Join(stage, "input.json")
			if err := os.WriteFile(input, data, 0600); err != nil {
				t.Fatal(err)
			}
			args := mediaDownloadArgs("abcdefghijk", stage)
			// Seule l'extraction réseau est remplacée par une fixture ; filtres et sorties
			// sont exactement ceux de production, dans la même invocation.
			args = append(args[:len(args)-2], "--load-info-json", input)
			before := requests.Load()
			output, err := mediaCommand(ctx, "yt-dlp", args...)
			if err != nil {
				t.Fatal(err)
			}
			info, language, err := parseMediaOutput(output, "abcdefghijk")
			if !errors.Is(err, test.want) {
				t.Fatalf("%v output=%s", err, output)
			}
			if test.want != nil {
				if requests.Load() != before {
					t.Fatal("rejected video downloaded bytes")
				}
				return
			}
			wantLanguage := "fr-FR"
			if test.split {
				wantLanguage = "en-US"
			}
			if language == nil || *language != wantLanguage {
				t.Fatalf("language=%v output=%s", language, output)
			}
			probe, err := mediaCommand(ctx, "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", info.Path)
			if err != nil {
				t.Fatal(err)
			}
			acquired, err := validateProbe(probe, info.Path, strings.TrimPrefix(filepath.Ext(info.Path), "."), info.Duration, nil)
			if err != nil {
				t.Fatalf("%v: %s", err, probe)
			}
			if acquired.VideoCodec == nil || *acquired.VideoCodec != "h264" || acquired.AudioCodec == nil || *acquired.AudioCodec != "aac" ||
				acquired.Width == nil || *acquired.Width != 320 || acquired.Height == nil || *acquired.Height != 180 || acquired.FPS == nil || *acquired.FPS != 25 {
				t.Fatalf("missing measured metadata: %+v", acquired)
			}
		})
	}
}

func TestSelectedAudioLanguageAndProtocol(t *testing.T) {
	source := "source:{\"id\":\"abcdefghijk\",\"extractor_key\":\"Youtube\",\"live_status\":\"not_live\"}\n"
	for _, test := range []struct{ name, language, tracks, want string }{
		{"combined", "fr-FR", `[]`, "fr-FR"},
		{"unknown", "", `[]`, ""},
		{"undefined", "und", `[]`, ""},
		{"invalid", "English audio", `[]`, ""},
		{"split_ignores_aggregate", "de+fr", `[{"acodec":"none","language":"de"},{"acodec":"opus","language":"en-US"}]`, "en-US"},
		{"split_unknown", "en-US", `[{"acodec":"none"},{"acodec":"opus"}]`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			info, _ := json.Marshal(mediaInfo{ID: "abcdefghijk", Extractor: "Youtube", LiveStatus: "not_live", Path: "/tmp/media.mp4", AudioCodec: "aac", Language: test.language})
			output := source + "result:{\"file\":" + string(info) + ",\"tracks\":" + test.tracks + "}\n"
			_, lang, err := parseMediaOutput([]byte(output), "abcdefghijk")
			if err != nil {
				t.Fatal(err)
			}
			if test.want == "" && lang != nil || test.want != "" && (lang == nil || *lang != test.want) {
				t.Fatalf("language=%v", lang)
			}
			if _, _, err := parseMediaOutput([]byte(output+output), "abcdefghijk"); !errors.Is(err, media.ErrInvalid) {
				t.Fatal("duplicate result accepted")
			}
		})
	}
	if _, _, err := parseMediaOutput([]byte(source), "abcdefghijk"); !errors.Is(err, media.ErrInvalid) {
		t.Fatal("missing final result accepted")
	}
}

func TestAverageFPS(t *testing.T) {
	for _, invalid := range []string{"", "0/0", "25/0", "-25/1", "NaN/1", "Inf/1", "25", "N/A"} {
		if averageFPS(invalid) != nil {
			t.Fatal(invalid)
		}
	}
	fps := averageFPS("30000/1001")
	if fps == nil || *fps < 29.97 || *fps > 29.971 {
		t.Fatal(fps)
	}
}

// TestNativeAudioPreference garde le choix original comme observation, pas comme filtre Sillage.
func TestNativeAudioPreference(t *testing.T) {
	binary, err := exec.LookPath("yt-dlp")
	if err != nil {
		t.Skip("yt-dlp unavailable")
	}
	v := format("v", "mp4", "h264", "none", "", 1920, 1080)
	original := format("original", "webm", "none", "opus", "en-US", 0, 0)
	original.LanguagePreference = 10
	dub := format("dub", "webm", "none", "opus", "fr-FR", 0, 0)
	dub.LanguagePreference = -1
	for _, originalPresent := range []bool{true, false} {
		formats := []mediaFormat{v, dub}
		want := "fr-FR"
		if originalPresent {
			formats = append(formats, original)
			want = "en-US"
		}
		dir := t.TempDir()
		path := filepath.Join(dir, "info.json")
		if err := os.WriteFile(path, nativeDiscovery(t, formats), 0600); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		output, err := mediaCommand(ctx, binary, "--ignore-config", "--no-cache-dir", "--simulate", "--dump-single-json", "--load-info-json", path, "-S", "res:1080", "-f", "bv*+ba/b")
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Formats []selectedAudio `json:"requested_formats"`
		}
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Formats) != 2 || result.Formats[1].Language != want {
			t.Fatalf("%s", output)
		}
	}
}
