package media_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestDownloadLoggingIdentifiesEachExecution(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "DEBUG", "json")
	p := &provider{gate: make(chan struct{})}
	service, _, _, v, _ := setup(t, p, time.Minute, logging.WithLogger(context.Background(), logger))
	request, cancel := context.WithCancel(logging.WithRequest(context.Background(), "origin"))
	if _, err := service.Start(request, v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := service.Start(context.Background(), v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	close(p.gate)
	first := waitState(t, service, v, "available")
	if err := service.Delete(context.Background(), v.ID, first.File.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Start(logging.WithRequest(context.Background(), "second"), v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	waitState(t, service, v, "available")
	service.Close()
	starts := map[string]string{}
	ends := map[string]int{}
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		event := row["event"]
		if event == "download.started" {
			starts[row["operation_id"].(string)] = row["origin_request_id"].(string)
		}
		if event == "download.completed" {
			ends[row["operation_id"].(string)]++
		}
	}
	if len(starts) != 2 || len(ends) != 2 {
		t.Fatal(output.String())
	}
	for id := range starts {
		if ends[id] != 1 {
			t.Fatal(output.String())
		}
	}
}

// TestProbeDiagnosticReachesTerminalEvent exerce l'erreur de l'adapter jusqu'au bilan INFO/ERROR.
func TestProbeDiagnosticReachesTerminalEvent(t *testing.T) {
	stage := t.TempDir()
	output := "source:{\"id\":\"abcdefghijk\",\"extractor_key\":\"Youtube\",\"live_status\":\"not_live\"}\n" +
		"result:{\"file\":{\"id\":\"abcdefghijk\",\"extractor_key\":\"Youtube\",\"live_status\":\"not_live\",\"acodec\":\"aac\",\"filepath\":\"" + stage + "/media.mp4\"},\"tracks\":[]}\n"
	downloader, probe := filepath.Join(stage, "download"), filepath.Join(stage, "probe")
	if err := os.WriteFile(downloader, []byte("#!/bin/sh\nprintf '%s' '"+output+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(probe, []byte("#!/bin/sh\necho 'Invalid data found PRIVATE https://secret.test' >&2\nexit 7\n"), 0700); err != nil {
		t.Fatal(err)
	}
	_, failure := (ytdlp.MediaClient{Binary: downloader, ProbeBinary: probe}).Download(
		context.Background(), video.VideoSource{Provider: "youtube", ExternalID: "abcdefghijk"}, stage,
	)
	if !errors.Is(failure, media.ErrInvalid) || media.Code(failure) != "media_invalid" {
		t.Fatal(failure)
	}
	var logs bytes.Buffer
	logger, _ := logging.New(&logs, "INFO", "json")
	service, _, _, v, _ := setup(t, &provider{err: failure}, time.Minute, logging.WithLogger(context.Background(), logger))
	if _, err := service.Start(context.Background(), v.ID, v.Sources[0].ID); err != nil {
		t.Fatal(err)
	}
	if state := waitState(t, service, v, "failed"); state.ErrorCode != "media_invalid" {
		t.Fatal(state)
	}
	service.Close()
	count := 0
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		if row["event"] != "download.failed" {
			continue
		}
		count++
		diagnostic, ok := row["error"].(map[string]any)
		if !ok || row["level"] != "ERROR" || diagnostic["reason"] != "invalid_media" ||
			diagnostic["tool"] != "ffprobe" || diagnostic["stage"] != "probe" || diagnostic["exit_code"] != float64(7) {
			t.Fatal(row)
		}
	}
	if count != 1 || strings.Contains(logs.String(), "PRIVATE") || strings.Contains(logs.String(), "secret.test") {
		t.Fatal(logs.String())
	}
}
