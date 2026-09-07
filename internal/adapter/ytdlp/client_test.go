package ytdlp

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestClientExtract(t *testing.T) {
	argsPath := filepath.Join(t.TempDir(), "args")
	t.Setenv("SILLAGE_TEST_ARGS", argsPath)
	fixture, err := filepath.Abs("testdata/youtube.json")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SILLAGE_TEST_FIXTURE", fixture)
	binary := writeExecutable(t, "printf '%s\\n' \"$@\" > \"$SILLAGE_TEST_ARGS\"\nprintf 'warning\\n' >&2\ncat \"$SILLAGE_TEST_FIXTURE\"\n")
	inputURL := "https://www.youtube.com/watch?v=BaW_jenozKc&list=example"
	got, err := (Client{Binary: binary}).Extract(context.Background(), inputURL)
	if err != nil {
		t.Fatal(err)
	}
	if got.ExternalID != "BaW_jenozKc" {
		t.Fatalf("unexpected source: %#v", got)
	}
	data, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--ignore-config", "--dump-single-json", "--simulate", "--no-playlist", "--no-progress", "--", inputURL}
	args := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("got args %q, want %q", args, want)
	}
}

func TestClientErrors(t *testing.T) {
	t.Run("missing executable", func(t *testing.T) {
		_, err := (Client{Binary: filepath.Join(t.TempDir(), "missing")}).Extract(context.Background(), "https://youtu.be/abc")
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("expected missing executable: %v", err)
		}
	})
	t.Run("exit status and stderr", func(t *testing.T) {
		binary := writeExecutable(t, "echo 'video unavailable' >&2\nexit 7\n")
		_, err := (Client{Binary: binary}).Extract(context.Background(), "https://youtu.be/abc")
		var exitError *exec.ExitError
		if !errors.As(err, &exitError) || exitError.ExitCode() != 7 || !strings.Contains(err.Error(), "video unavailable") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("invalid JSON", func(t *testing.T) {
		binary := writeExecutable(t, "echo 'not JSON'\n")
		_, err := (Client{Binary: binary}).Extract(context.Background(), "https://youtu.be/abc")
		if err == nil || !strings.Contains(err.Error(), "parse yt-dlp") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	t.Run("cancellation", func(t *testing.T) {
		binary := writeExecutable(t, "exec sleep 30\n")
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		_, err := (Client{Binary: binary}).Extract(ctx, "https://youtu.be/abc")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestClientRejectsInvalidURLBeforeExecution(t *testing.T) {
	for _, inputURL := range []string{"", "--version", "file:///tmp/video", "https://example.com/video", "https://youtube.com.evil.test/video", "https://user@youtube.com/watch?v=abc", "://"} {
		t.Run(inputURL, func(t *testing.T) {
			_, err := (Client{Binary: "/does-not-exist"}).Extract(context.Background(), inputURL)
			if err == nil || strings.Contains(err.Error(), "execute yt-dlp") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// writeExecutable simule le processus externe sous Linux sans réseau ni yt-dlp.
func writeExecutable(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "yt-dlp")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}
