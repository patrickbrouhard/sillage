package ytdlp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestPublisherMetadataIdentity(t *testing.T) {
	for _, tc := range []struct {
		fields string
		name   string
		exists bool
	}{
		{`"channel_id":"UC1234567890123456789012","channel":" Channel "`, "Channel", true},
		{`"channel_id":"UC1234567890123456789012","uploader":" Fallback "`, "Fallback", true},
		{`"channel_id":"UC1234567890123456789012"`, "", true},
		{`"channel":"Name only","creators":["Other"]`, "", false},
		{`"channel_id":"@handle","channel":"Name"`, "", false},
		{`"uploader_id":"UC1234567890123456789012"`, "", false},
	} {
		source, err := parseMetadata([]byte(`{"extractor_key":"Youtube","id":"video","title":"Title",` + tc.fields + `}`))
		if err != nil || (source.Publisher != nil) != tc.exists {
			t.Fatal(source, err)
		}
		if tc.exists && source.Publisher.Name != tc.name {
			t.Fatal(source.Publisher)
		}
	}
	for _, data := range []string{`null`, `{}`, `{"_type":"video","extractor_key":"Youtube","channel_id":"UC1234567890123456789012"}`, `{"_type":"playlist","extractor_key":"YoutubeTab","channel":"Name only"}`} {
		if _, err := parsePublisher([]byte(data)); !errors.Is(err, video.ErrMetadataFetchFailed) {
			t.Fatal(data, err)
		}
	}
}

func TestResolvePublisherProcess(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "yt-dlp")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nprintf '%s' '{\"_type\":\"playlist\",\"extractor_key\":\"YoutubeTab\",\"channel_id\":\"UC1234567890123456789012\",\"channel\":\"Clips\"}'\n"
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	client := Client{Binary: binary}
	for _, input := range []string{"https://www.youtube.com/@LexClips", "https://youtube.com/channel/UC1234567890123456789012/videos", "https://youtube.com/user/example"} {
		p, err := client.ResolvePublisher(context.Background(), input)
		if err != nil || p.Name != "Clips" || p.ExternalID != "UC1234567890123456789012" {
			t.Fatal(p, err)
		}
	}
	args, err := os.ReadFile(binary + ".args")
	if err != nil || !strings.Contains(string(args), "--playlist-items\n0\n") || !strings.Contains(string(args), "--flat-playlist\n") {
		t.Fatal(string(args), err)
	}
	for _, input := range []string{"https://youtube.com/watch?v=x", "https://youtu.be/x", "https://youtube.com/playlist?list=x", "https://evil.test/@name", "https://user@youtube.com/@name", "file:///tmp/channel", "https://youtube.com/channel/@name"} {
		if _, err := client.ResolvePublisher(context.Background(), input); !errors.Is(err, video.ErrInvalidInput) {
			t.Fatal(input, err)
		}
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ResolvePublisher(context.Background(), "https://youtube.com/@test"); !errors.Is(err, video.ErrMetadataFetchFailed) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	<-ctx.Done()
	if _, err := client.ResolvePublisher(ctx, "https://youtube.com/@test"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
