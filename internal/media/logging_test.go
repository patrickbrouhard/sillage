package media_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"strings"
	"testing"
	"time"
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
