package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type readStub struct {
	video      func(context.Context, video.VideoID) (video.Video, error)
	note       func(context.Context, video.VideoID) (note.Note, error)
	transcript func(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error)
	search     func(context.Context, string, int, search.Sort) (search.Page, error)
}

// GetVideo rend tout accès inattendu visible, sans service d’écriture disponible.
func (s readStub) GetVideo(ctx context.Context, id video.VideoID) (video.Video, error) {
	if s.video == nil {
		panic("unexpected video read")
	}
	return s.video(ctx, id)
}

// Get refuse toute lecture non prévue par le scénario de note.
func (s readStub) Get(ctx context.Context, id video.VideoID) (note.Note, error) {
	if s.note == nil {
		panic("unexpected note read")
	}
	return s.note(ctx, id)
}

// Search transmet les critères au double de lecture et refuse les appels imprévus.
func (s readStub) Search(ctx context.Context, q string, page int, sort search.Sort) (search.Page, error) {
	if s.search == nil {
		panic("unexpected search")
	}
	return s.search(ctx, q, page, sort)
}

type transcriptStub struct{ readStub }

// Get n’offre aucune capacité Fetch ou de remplacement de source.
func (s transcriptStub) Get(ctx context.Context, id video.VideoID, source video.VideoSourceID) (transcript.Result, error) {
	if s.transcript == nil {
		panic("unexpected transcript read")
	}
	return s.transcript(ctx, id, source)
}
func stubReaders(s readStub) Readers {
	return Readers{Videos: s, Notes: s, Search: s, Transcripts: transcriptStub{s}}
}

func endpoint(t *testing.T, readers Readers, adjust func(*Handler)) (*Handler, *httptest.Server) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	authority := server.Listener.Addr().String()
	handler, err := New(context.Background(), readers, []string{authority, net.JoinHostPort("localhost", strings.Split(authority, ":")[1])})
	if err != nil {
		t.Fatal(err)
	}
	if adjust != nil {
		adjust(handler)
	}
	server.Config.Handler = handler
	server.Start()
	t.Cleanup(func() { handler.Close(); server.Close() })
	return handler, server
}

func connect(t *testing.T, server *httptest.Server, version string) *sdk.ClientSession {
	t.Helper()
	return connectEndpoint(t, server.Client(), server.URL, version)
}

func connectEndpoint(t *testing.T, clientHTTP *http.Client, endpoint, version string) *sdk.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "sillage-test", Version: "1"}, &sdk.ClientOptions{
		Capabilities: &sdk.ClientCapabilities{},
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:             endpoint,
		HTTPClient:           clientHTTP,
		DisableStandaloneSSE: true,
		MaxRetries:           -1,
	}, &sdk.ClientSessionOptions{ProtocolVersion: version})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	if got := session.InitializeResult().ProtocolVersion; got != version {
		t.Fatalf("protocol %s, want %s", got, version)
	}
	caps := session.InitializeResult().Capabilities
	if caps.Tools == nil || caps.Tools.ListChanged || caps.Logging != nil || caps.Resources != nil || caps.Prompts != nil {
		t.Fatalf("unexpected capabilities: %+v", caps)
	}
	return session
}

func call(t *testing.T, session *sdk.ClientSession, tool string, args any) *sdk.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Content) != 1 {
		t.Fatalf("missing text fallback: %+v", result)
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var fromText any
	if err := json.Unmarshal([]byte(result.Content[0].(*sdk.TextContent).Text), &fromText); err != nil {
		t.Fatal(err)
	}
	var fromStructured any
	if err := json.Unmarshal(data, &fromStructured); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fromText, fromStructured) {
		t.Fatal("text and structured content differ")
	}
	return result
}

func decode[T any](t *testing.T, result *sdk.CallToolResult) T {
	t.Helper()
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func assertCode(t *testing.T, result *sdk.CallToolResult, code string) errorDTO {
	t.Helper()
	value := decode[struct{ Error errorDTO }](t, result)
	if !result.IsError || value.Error.Code != code {
		t.Fatalf("expected %s, got %+v", code, result)
	}
	return value.Error
}

// TestHTTPProtocolsSchemasAndValidation vérifie la découverte réelle et les arguments refusés sur chaque protocole.
func TestHTTPProtocolsSchemasAndValidation(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25", "2025-06-18"} {
		t.Run(version, func(t *testing.T) {
			_, server := endpoint(t, stubReaders(readStub{
				search: func(_ context.Context, q string, p int, s search.Sort) (search.Page, error) {
					if q != "Kubernetes" || p != 1 || s != search.SortRelevance {
						t.Errorf("defaults: %q %d %s", q, p, s)
					}
					return search.Page{}, nil
				},
			}), nil)
			session := connect(t, server, version)
			list, err := session.ListTools(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string][]string{
				"search_videos": {"query"}, "get_video": {"video_id"},
				"get_note": {"video_id"}, "get_transcript": {"video_id", "source_id"},
			}
			if len(list.Tools) != 4 {
				t.Fatalf("%d tools", len(list.Tools))
			}
			for _, tool := range list.Tools {
				if !reflect.DeepEqual(tool.InputSchema.(map[string]any)["required"], stringAnys(want[tool.Name])) {
					t.Fatalf("required: %+v", tool)
				}
				schemaBytes, _ := json.Marshal(tool.InputSchema)
				var schema jsonschema.Schema
				if err := json.Unmarshal(schemaBytes, &schema); err != nil {
					t.Fatal(err)
				}
				resolved, err := schema.Resolve(nil)
				if err != nil {
					t.Fatal(err)
				}
				sample := map[string]any{"video_id": 1, "unknown": true}
				if tool.Name == "search_videos" {
					sample = map[string]any{"query": "x", "unknown": true}
				}
				if tool.Name == "get_transcript" {
					sample["source_id"] = 1
				}
				var object any = sample
				if resolved.Validate(&object) == nil {
					t.Fatal("unknown property allowed")
				}
				if tool.OutputSchema == nil || tool.Annotations == nil || !tool.Annotations.ReadOnlyHint ||
					!tool.Annotations.IdempotentHint || *tool.Annotations.OpenWorldHint || *tool.Annotations.DestructiveHint {
					t.Fatalf("schema/annotations: %+v", tool)
				}
			}
			if got := call(t, session, "search_videos", map[string]any{"query": "Kubernetes"}); got.IsError {
				t.Fatal(got)
			}
			cases := []struct {
				name string
				args string
			}{
				{"search_videos", `{}`},
				{"search_videos", `{"query":null}`},
				{"search_videos", `{"query":1}`},
				{"search_videos", `{"query":"PRIVATE","page":0}`},
				{"search_videos", `{"query":"PRIVATE","page":1001}`},
				{"search_videos", `{"query":"PRIVATE","page":null}`},
				{"search_videos", `{"query":"PRIVATE","page":1.5}`},
				{"search_videos", `{"query":"PRIVATE","sort":""}`},
				{"search_videos", `{"query":"PRIVATE","sort":"Newest"}`},
				{"search_videos", `{"query":"PRIVATE","sort":null}`},
				{"search_videos", `{"query":"PRIVATE","limit":1}`},
				{"get_video", `{}`},
				{"get_video", `{"video_id":0}`},
				{"get_video", `{"video_id":-1}`},
				{"get_video", `{"video_id":"1"}`},
				{"get_video", `{"video_id":null}`},
				{"get_video", `{"video_id":1.2}`},
				{"get_video", `{"video_id":9223372036854775808}`},
				{"get_note", `{"video_id":1,"extra":"PRIVATE"}`},
				{"get_transcript", `{"video_id":1}`},
				{"get_transcript", `{"video_id":1,"source_id":0}`},
				{"get_transcript", `{"video_id":1,"source_id":1,"format":""}`},
				{"get_transcript", `{"video_id":1,"source_id":1,"format":null}`},
				{"get_transcript", `{"video_id":1,"source_id":1,"format":"json"}`},
				{"get_transcript", `{"video_id":1,"source_id":1,"language":"fr"}`},
			}
			for _, tc := range cases {
				result := call(t, session, tc.name, json.RawMessage(tc.args))
				assertCode(t, result, "invalid_arguments")
				if strings.Contains(result.Content[0].(*sdk.TextContent).Text, "PRIVATE") {
					t.Fatal("input leaked")
				}
			}
		})
	}
}

func stringAnys(values []string) []any {
	result := make([]any, len(values))
	for i, v := range values {
		result[i] = v
	}
	return result
}

// TestErrorSanitizationAndLogs vérifie que les causes techniques restent privées.
func TestErrorSanitizationAndLogs(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{video.ErrVideoNotFound, "video_not_found"},
		{video.ErrVideoSourceNotFound, "source_not_found"},
		{note.ErrNotFound, "note_not_found"},
		{transcript.ErrNotFound, "transcript_not_found"},
		{transcript.ErrReadFailed, "transcript_read_failed"},
		{search.ErrInvalidInput, "invalid_arguments"},
		{video.ErrInvalidInput, "invalid_arguments"},
		{context.DeadlineExceeded, "deadline_exceeded"},
		{context.Canceled, "canceled"},
		{errors.New("SQL /private/path signed-url PRIVATE"), "internal_error"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			_, server := endpoint(t, stubReaders(readStub{note: func(context.Context, video.VideoID) (note.Note, error) {
				return note.Note{}, fmt.Errorf("PRIVATE diagnostic: %w", tc.err)
			}}), nil)
			result := call(t, connect(t, server, "2026-07-28"), "get_note", map[string]any{"video_id": 1})
			assertCode(t, result, tc.code)
			data, _ := json.Marshal(result)
			if strings.Contains(string(data), "PRIVATE") || strings.Contains(string(data), "/private") {
				t.Fatal("technical error leaked")
			}
		})
	}
}

// lockedBuffer rend les journaux observables sans course avec les handlers HTTP.
type lockedBuffer struct {
	mu   sync.Mutex
	data strings.Builder
}

// Write protège les journaux produits par les goroutines du transport.
func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.Write(p)
}

// String fournit une vue cohérente pour les assertions de confidentialité.
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.data.String() }

// TestToolLogSeparatesHTTPAndDoesNotExposeContent distingue le résultat métier du statut HTTP sans journaliser le contenu.
func TestToolLogSeparatesHTTPAndDoesNotExposeContent(t *testing.T) {
	var logs lockedBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler, server := endpoint(t, stubReaders(readStub{note: func(context.Context, video.VideoID) (note.Note, error) {
		return note.Note{}, errors.New("PRIVATE/path/secret")
	}}), nil)
	original := server.Config.Handler
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := logging.WithLogger(r.Context(), logger.With("http_request_id", "safe-correlation"))
		original.ServeHTTP(w, r.WithContext(ctx))
	})
	_ = handler
	call(t, connect(t, server, "2025-11-25"), "get_note", map[string]any{"video_id": 1})
	got := logs.String()
	for _, value := range []string{"mcp.tool_completed", "get_note", "internal_error", "safe-correlation"} {
		if !strings.Contains(got, value) {
			t.Fatalf("missing %s: %s", value, got)
		}
	}
	if strings.Contains(got, "PRIVATE") {
		t.Fatal(got)
	}
}
