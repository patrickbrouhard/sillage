package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// wireRecorder observe le JSON transmis, après tous les enrichissements du SDK.
type wireRecorder struct {
	base      http.RoundTripper
	mu        sync.Mutex
	result    json.RawMessage
	httpBytes int
	versions  []string
}

// RoundTrip conserve les octets de résultat et restitue le corps intact au client MCP.
func (w *wireRecorder) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := w.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(bytes.NewReader(data))
	var envelope struct{ Result json.RawMessage }
	if json.Unmarshal(data, &envelope) == nil && bytes.Contains(envelope.Result, []byte(`"supportedVersions"`)) {
		var discovery struct{ SupportedVersions []string }
		if json.Unmarshal(envelope.Result, &discovery) == nil {
			w.mu.Lock()
			w.versions = discovery.SupportedVersions
			w.mu.Unlock()
		}
	}
	if json.Unmarshal(data, &envelope) == nil && bytes.Contains(envelope.Result, []byte(`"content"`)) {
		w.mu.Lock()
		w.result = append(json.RawMessage(nil), envelope.Result...)
		w.httpBytes = len(data)
		w.mu.Unlock()
	}
	return response, nil
}

// snapshot se synchronise avec le client sans modifier les données enregistrées.
func (w *wireRecorder) snapshot() (json.RawMessage, int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append(json.RawMessage(nil), w.result...), w.httpBytes
}

// TestFinalResultWireBoundaries vérifie le plafond final sur chaque révision conservée.
func TestFinalResultWireBoundaries(t *testing.T) {
	text := "PAYLOAD-" + strings.Repeat("東京 🦊 <>& \" \\ \n\t\r\b\f\x00 \u2028 \u2029", 160)
	readers := stubReaders(readStub{note: func(context.Context, video.VideoID) (note.Note, error) {
		return note.Note{VideoID: 1, Revision: 1, ContentMD: text}, nil
	}})
	for _, version := range supportedProtocolVersions {
		t.Run(version, func(t *testing.T) {
			measure := func(limit int) (*sdk.CallToolResult, json.RawMessage, int) {
				_, server := endpoint(t, readers, func(h *Handler) {
					if limit > 0 {
						h.responseBytes = limit
					}
				})
				recorder := &wireRecorder{base: server.Client().Transport}
				session := connectEndpoint(t, &http.Client{Transport: recorder}, server.URL, version)
				result := call(t, session, "get_note", map[string]any{"video_id": 1})
				raw, httpSize := recorder.snapshot()
				return result, raw, httpSize
			}
			baseline, raw, httpSize := measure(0)
			if baseline.IsError {
				t.Fatal(baseline)
			}
			size := len(raw)
			if httpSize <= size {
				t.Fatal("JSON-RPC envelope not separated")
			}
			hasNewFields := bytes.Contains(raw, []byte(`"resultType":"complete"`)) &&
				bytes.Contains(raw, []byte(sdk.MetaKeyServerInfo))
			if hasNewFields != (version == "2026-07-28") {
				t.Fatalf("SDK enrichment: %s", raw[:min(180, len(raw))])
			}
			for _, difference := range []int{-1, 0, 1} {
				// Un même résultat est juste au-dessus, à la limite, puis juste sous le plafond.
				limit := size + difference
				t.Run(fmt.Sprint(difference), func(t *testing.T) {
					result, received, _ := measure(limit)
					if difference < 0 {
						value := assertCode(t, result, "response_too_large")
						if value.SerializedBytes != size || value.SerializedBytesAtLeast != 0 || value.LimitBytes != limit {
							t.Fatalf("%+v", value)
						}
						if bytes.Contains(received, []byte("PAYLOAD-")) {
							t.Fatal("partial content")
						}
					} else {
						if result.IsError || len(received) != size || decode[noteDTO](t, result).ContentMD != text {
							t.Fatalf("final wire size=%d want=%d", len(received), size)
						}
					}
				})
			}
		})
	}
}

// TestBatchesRejectedBeforeReaders ferme le défaut sans en-tête et les révisions anciennes.
func TestBatchesRejectedBeforeReaders(t *testing.T) {
	var calls atomic.Int32
	_, server := endpoint(t, stubReaders(readStub{note: func(context.Context, video.VideoID) (note.Note, error) {
		calls.Add(1)
		return note.Note{VideoID: 1, Revision: 1}, nil
	}}), nil)
	for _, version := range []string{"2025-03-26", "", "2025-06-18", "2025-11-25", "2026-07-28"} {
		for _, body := range []string{"[" + noteCall + "]", " \n\t [", strings.Repeat(" ", MaxRequestBytes-1) + "["} {
			response := post(t, server, body, map[string]string{"MCP-Protocol-Version": version})
			readBody(t, response)
			if response.StatusCode != 400 {
				t.Fatalf("version=%q status=%d", version, response.StatusCode)
			}
		}
	}
	response := post(t, server, noteCall, map[string]string{"MCP-Protocol-Version": "2025-03-26"})
	readBody(t, response)
	if response.StatusCode != 400 || calls.Load() != 0 {
		t.Fatalf("business reads: %d", calls.Load())
	}
}

// TestLegacyInitializeWithoutHeader préserve la négociation historique normale du SDK.
func TestLegacyInitializeWithoutHeader(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{}), nil)
	for _, version := range []string{"2025-06-18", "2025-11-25"} {
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":%q,"capabilities":{},"clientInfo":{"name":"historical","version":"1"}}}`, version)
		response := post(t, server, body, map[string]string{"MCP-Protocol-Version": ""})
		received := readBody(t, response)
		var envelope struct {
			Result struct{ ProtocolVersion string }
		}
		if err := json.Unmarshal([]byte(received), &envelope); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 || envelope.Result.ProtocolVersion != version {
			t.Fatalf("%d %s", response.StatusCode, received)
		}
	}
}

// TestAdvertisedVersionsAreRestricted empêche un élargissement implicite lors d’une mise à jour SDK.
func TestAdvertisedVersionsAreRestricted(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{}), nil)
	recorder := &wireRecorder{base: server.Client().Transport}
	connectEndpoint(t, &http.Client{Transport: recorder}, server.URL, "2026-07-28")
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if !reflect.DeepEqual(recorder.versions, []string{"2026-07-28", "2025-11-25", "2025-06-18"}) {
		t.Fatalf("advertised versions: %v", recorder.versions)
	}
}
