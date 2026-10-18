package asset_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestCaptureLoggingSurvivesRequestAndFallback(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "DEBUG", "json")
	root := logging.WithLogger(context.Background(), logger)
	gate := make(chan struct{})
	service, _, v, _ := setup(t, &localMedia{path: "local"}, func(ctx context.Context, _ video.VideoSource, path string, _ int64, stage string) error {
		if path != "" {
			return asset.ErrExtract
		}
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
		logging.From(ctx).DebugContext(ctx, "test adapter", "event", "test.adapter")
		return writePNG(stage)
	}, root)
	request, cancel := context.WithCancel(logging.WithRequest(context.Background(), "origin"))
	a, err := service.Start(request, v.ID, v.Sources[0].ID, 123, "command_000000001")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := service.Start(context.Background(), v.ID, v.Sources[0].ID, 123, a.RequestID); err != nil {
		t.Fatal(err)
	}
	close(gate)
	if got := waitAsset(t, service, a.ID); got.Status != "available" {
		t.Fatal(got)
	}
	service.Close()
	counts := map[string]int{}
	operation := ""
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		counts[row["event"].(string)]++
		if operation == "" {
			operation = row["operation_id"].(string)
		}
		if row["operation_id"] != operation || row["origin_request_id"] != "origin" || row["http_request_id"] != nil {
			t.Fatal(row)
		}
		if row["level"] == "ERROR" {
			t.Fatal(row)
		}
	}
	if counts["capture.started"] != 1 || counts["capture.completed"] != 1 || counts["capture.fallback"] != 1 || counts["test.adapter"] != 1 {
		t.Fatal(counts)
	}
}

func TestCaptureShutdownLogging(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "INFO", "json")
	service, _, v, _ := setup(t, &localMedia{err: media.ErrNotFound}, func(ctx context.Context, _ video.VideoSource, _ string, _ int64, _ string) error {
		<-ctx.Done()
		return ctx.Err()
	}, logging.WithLogger(context.Background(), logger))
	if _, err := service.Start(context.Background(), v.ID, v.Sources[0].ID, 0, "command_shutdown"); err != nil {
		t.Fatal(err)
	}
	service.Close()
	if strings.Count(output.String(), `"event":"capture.interrupted"`) != 1 || strings.Contains(output.String(), `"level":"ERROR"`) {
		t.Fatal(output.String())
	}
}

// unavailableFinalization simule une indisponibilité SQL après publication du PNG.
type unavailableFinalization struct {
	asset.Repository
	attempts chan struct{}
}

func (r unavailableFinalization) Finish(context.Context, int64, string, *string, int64, string) error {
	r.attempts <- struct{}{}
	return errors.New("PRIVATE SQL")
}
func (r unavailableFinalization) Get(context.Context, int64) (asset.Asset, error) {
	return asset.Asset{}, errors.New("PRIVATE SQL")
}

func TestCaptureUnconfirmedFinalizationIsNeverSuccess(t *testing.T) {
	original, repo, v, storage := setup(t, &localMedia{}, nil)
	original.Close()
	var output bytes.Buffer
	logger, _ := logging.New(&output, "DEBUG", "json")
	ctx := logging.WithLogger(context.Background(), logger)
	attempts := make(chan struct{}, 2)
	service, err := asset.NewService(ctx, fixedVideo{v}, unavailableFinalization{repo, attempts}, &localMedia{err: media.ErrNotFound}, extractor(func(_ context.Context, _ video.VideoSource, _ string, _ int64, stage string) error {
		return writePNG(stage)
	}), storage, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if _, err := service.Start(context.Background(), v.ID, v.Sources[0].ID, 0, "command_uncertain"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-attempts:
		case <-time.After(time.Second):
			t.Fatal("finalization not attempted")
		}
	}
	service.Close()
	if strings.Count(output.String(), "capture.finalization_uncertain") != 1 || strings.Contains(output.String(), "capture.completed") || strings.Contains(output.String(), "PRIVATE") {
		t.Fatal(output.String())
	}
}
