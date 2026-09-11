package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func clearConfig(t *testing.T) {
	t.Helper()
	for _, key := range []string{"SILLAGE_HTTP_ADDR", "SILLAGE_POST_TIMEOUT"} {
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
	cfg, err = loadConfig()
	if err != nil || cfg.addr != "0.0.0.0:9000" || cfg.postTimeout != 90*time.Second {
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
	server := newHTTPServer("127.0.0.1:0", api.NewRouter(waitingService{}, 30*time.Millisecond))
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
	client := &http.Client{Timeout: 2 * time.Second}
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
	cfg := config{addr: listener.Addr().String(), postTimeout: time.Minute}
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
