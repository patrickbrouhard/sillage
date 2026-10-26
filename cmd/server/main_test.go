package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func clearConfig(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"SILLAGE_HTTP_ADDR",
		"SILLAGE_POST_TIMEOUT",
		"SILLAGE_WEB_DIR",
		"SILLAGE_DOWNLOAD_TIMEOUT",
		"SILLAGE_LOG_LEVEL",
		"SILLAGE_LOG_FORMAT",
		"SILLAGE_MCP_ENABLED",
		"SILLAGE_MCP_ALLOWED_AUTHORITIES",
	} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConfig(t *testing.T) {
	clearConfig(t)
	cfg, err := loadConfig()
	if err != nil || cfg.addr != "127.0.0.1:8080" || cfg.postTimeout != time.Minute {
		t.Fatalf("%+v %v", cfg, err)
	}
	t.Setenv("SILLAGE_HTTP_ADDR", "0.0.0.0:9000")
	t.Setenv("SILLAGE_POST_TIMEOUT", "90s")
	t.Setenv("SILLAGE_WEB_DIR", "/tmp/frontend")
	cfg, err = loadConfig()
	if err != nil || cfg.addr != "0.0.0.0:9000" || cfg.postTimeout != 90*time.Second || cfg.webDir != "/tmp/frontend" {
		t.Fatalf("%+v %v", cfg, err)
	}
	for _, value := range []string{"", "oops", "0s", "-1s"} {
		t.Setenv("SILLAGE_POST_TIMEOUT", value)
		if _, err := loadConfig(); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	t.Setenv("SILLAGE_POST_TIMEOUT", "60s")
	t.Setenv("SILLAGE_HTTP_ADDR", "invalid")
	if _, err := loadConfig(); err == nil {
		t.Fatal("accepted invalid address")
	}
}

type waitingService struct{}

func (waitingService) AddVideo(ctx context.Context, _ string) (video.AddVideoResult, error) {
	<-ctx.Done()
	return video.AddVideoResult{}, ctx.Err()
}
func (waitingService) GetVideo(context.Context, video.VideoID) (video.Video, error) {
	panic("unexpected Get")
}
func (waitingService) ListVideos(context.Context) ([]video.Video, error) { panic("unexpected List") }

func TestApplicationTimeoutWritesJSONOverTCP(t *testing.T) {
	server := newHTTPServer("127.0.0.1:0", api.NewRouter(nil, nil, nil, nil, nil, nil, waitingService{}, 30*time.Millisecond))
	// Une lecture bornée ne doit pas devenir une limite d'écriture pendant le traitement.
	server.ReadTimeout = 5 * time.Millisecond
	if server.WriteTimeout != 0 {
		t.Fatal("write deadline can truncate application timeout response")
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	defer func() { server.Close(); <-done }()
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Post("http://"+listener.Addr().String()+"/api/v1/videos", "application/json; charset=utf-8", strings.NewReader(`{"url":"https://youtu.be/x"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct{ Error struct{ Code string } }
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 504 || body.Error.Code != "metadata_fetch_timeout" {
		t.Fatalf("%d %+v", response.StatusCode, body)
	}
}

func TestRunCreatesNewDefaultWithoutMovingOldDatabase(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	original := []byte("existing root database must remain untouched")
	if err := os.WriteFile("sillage.db", original, 0600); err != nil {
		t.Fatal(err)
	}
	// Une adresse occupée arrête run après l'ouverture de la nouvelle base.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg := config{addr: listener.Addr().String(), downloadTimeout: 6 * time.Hour, postTimeout: time.Minute}
	if err := run(context.Background(), cfg); err == nil {
		t.Fatal("expected occupied listener")
	}
	got, err := os.ReadFile("sillage.db")
	if err != nil || string(got) != string(original) {
		t.Fatal("old database changed", err)
	}
	if info, err := os.Stat(filepath.Join(dir, "data", "sillage.db")); err != nil || info.Size() == 0 {
		t.Fatal("new database not created", err)
	}
}

func (waitingService) ListVideosByTag(context.Context, video.TagID) ([]video.Video, error) {
	panic("unexpected filter")
}

func TestDownloadConfig(t *testing.T) {
	clearConfig(t)
	cfg, err := loadConfig()
	if err != nil || cfg.downloadTimeout != 6*time.Hour {
		t.Fatalf("%+v %v", cfg, err)
	}
	t.Setenv("SILLAGE_DOWNLOAD_TIMEOUT", "90m")
	cfg, err = loadConfig()
	if err != nil || cfg.downloadTimeout != 90*time.Minute {
		t.Fatalf("%+v %v", cfg, err)
	}
	for _, value := range []string{"", "0s", "-1s", "invalid"} {
		t.Setenv("SILLAGE_DOWNLOAD_TIMEOUT", value)
		if _, err := loadConfig(); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}

func TestServerStopsActiveMediaBeforeClosingDatabase(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	t.Setenv("PATH", dir+":/usr/bin:/bin")
	discovery := `{"id":"abcdefghijk","extractor_key":"Youtube","title":"Test","duration":10,"live_status":"not_live","formats":[{"format_id":"18","ext":"mp4","vcodec":"avc1","acodec":"mp4a","width":640,"height":360,"url":"https://example.test/media"}]}`
	script := fmt.Sprintf("#!/bin/sh\ncase \"$*\" in *--dump-single-json*) printf '%%s' '%s'; exit 0;; esac\ntrap '' TERM\nsleep 60 &\necho $! > '%s/child.pid'\nwait\n", discovery, dir)
	if err := os.WriteFile(filepath.Join(dir, "yt-dlp"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx, config{addr: addr, postTimeout: time.Second, downloadTimeout: time.Minute}) }()
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	base := "http://" + addr + "/api/v1"
	deadline := time.Now().Add(3 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		resp, err := client.Get(base + "/videos")
		if err == nil {
			resp.Body.Close()
			ready = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !ready {
		t.Fatal("server unavailable")
	}
	resp, err := client.Post(base+"/videos", "application/json", strings.NewReader(`{"url":"https://youtu.be/abcdefghijk"}`))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		ID      int64
		Sources []struct{ ID int64 }
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(v.Sources) != 1 {
		t.Fatalf("%+v", v)
	}
	resp, err = client.Post(fmt.Sprintf("%s/videos/%d/sources/%d/download", base, v.ID, v.Sources[0].ID), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 202 {
		t.Fatal(resp.StatusCode)
	}
	var child int
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(dir, "child.pid")); err == nil {
			child, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			if child > 0 {
				break
			}
		}
		time.Sleep(time.Millisecond)
	}
	if child == 0 {
		t.Fatal("download not started")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(12 * time.Second):
		t.Fatal("shutdown did not finish")
	}
	// SIGKILL est asynchrone : attendre aussi l'arrêt du descendant, pas seulement du parent.
	// Un zombie ne travaille plus et peut attendre sa collecte par le processus init.
	deadline = time.Now().Add(2 * time.Second)
	for {
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", child))
		if errors.Is(err, os.ErrNotExist) || (err == nil && strings.Contains(string(stat), ") Z ")) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if !time.Now().Before(deadline) {
			_ = syscall.Kill(child, syscall.SIGKILL)
			t.Fatalf("child survived: %s", stat)
		}
		time.Sleep(5 * time.Millisecond)
	}
	entries, err := os.ReadDir("data/media")
	if err != nil || len(entries) != 0 {
		t.Fatalf("staging survived: %v %v", entries, err)
	}
}

func TestMediaStorageFaultDoesNotStopHTTPInitialization(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.Mkdir("data", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("data/media", []byte("inaccessible media root"), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	err = run(context.Background(), config{addr: listener.Addr().String(), postTimeout: time.Minute, downloadTimeout: time.Hour})
	// L'adresse occupée est atteinte seulement si l'initialisation média a laissé le serveur continuer.
	if err == nil || !strings.Contains(err.Error(), "address already in use") {
		t.Fatalf("server stopped before HTTP: %v", err)
	}
}

func TestLoggingConfig(t *testing.T) {
	clearConfig(t)
	cfg, err := loadConfig()
	if err != nil || cfg.logLevel != "INFO" || cfg.logFormat != "text" {
		t.Fatal(cfg, err)
	}
	t.Setenv("SILLAGE_LOG_FORMAT", "json")
	t.Setenv("SILLAGE_LOG_LEVEL", "DEBUG")
	cfg, err = loadConfig()
	if err != nil || cfg.logFormat != "json" || cfg.logLevel != "DEBUG" {
		t.Fatal(cfg, err)
	}
	t.Setenv("SILLAGE_LOG_LEVEL", "PRIVATE")
	if _, err = loadConfig(); err == nil || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatal(err)
	}
}
