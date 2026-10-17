package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
)

func TestFormatsLevelsAndPrivacy(t *testing.T) {
	for _, format := range []string{"text", "json"} {
		for _, level := range []string{"DEBUG", "INFO", "WARN", "ERROR"} {
			t.Run(format+level, func(t *testing.T) {
				var out bytes.Buffer
				logger, err := New(&out, level, format)
				if err != nil {
					t.Fatal(err)
				}
				ctx := WithLogger(context.Background(), logger.With("http_request_id", "one"))
				From(ctx).Debug("debug")
				From(ctx).Info("info")
				From(ctx).Warn("warn")
				From(ctx).Error("error", Error(fmt.Errorf("PRIVATE: %w", &os.PathError{Op: "open", Path: "PRIVATE", Err: os.ErrPermission})))
				if strings.Contains(out.String(), "PRIVATE") {
					t.Fatal("private error leaked")
				}
				counts := map[string]int{"DEBUG": 4, "INFO": 3, "WARN": 2, "ERROR": 1}
				lines := strings.Split(strings.TrimSpace(out.String()), "\n")
				if len(lines) != counts[level] {
					t.Fatal(out.String())
				}
				if format == "json" {
					for _, line := range lines {
						var row map[string]any
						if json.Unmarshal([]byte(line), &row) != nil || row["http_request_id"] != "one" {
							t.Fatal(line)
						}
					}
				}
			})
		}
	}
	for _, pair := range [][2]string{{"TRACE", "json"}, {"", "text"}, {"INFO", "yaml"}} {
		if _, err := New(&bytes.Buffer{}, pair[0], pair[1]); err == nil {
			t.Fatal("accepted invalid configuration")
		}
	}
	From(context.Background()).Info("silent")
	if Error(errors.New("PRIVATE")).Value.Group()[0].Value.String() != "internal_error" {
		t.Fatal("unexpected diagnostic")
	}
	var out bytes.Buffer
	logger, _ := New(&out, "INFO", "json")
	logger.Info("line\nbreak", slog.String("value", "a\nb"))
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatal("multiline record")
	}
}
