package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func post(t *testing.T, server *httptest.Server, body string, headers map[string]string) *http.Response {
	t.Helper()
	request, err := http.NewRequest("POST", server.URL, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	for key, value := range headers {
		if key == "Host" {
			request.Host = value
		} else {
			request.Header.Set(key, value)
		}
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

const noteCall = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_note","arguments":{"video_id":1}}}`

// TestHTTPHostOriginAndCache interdit les autorités étrangères, les origines ambiguës et le cache partagé.
func TestHTTPHostOriginAndCache(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{note: func(context.Context, video.VideoID) (note.Note, error) {
		return note.Note{VideoID: 1, Revision: 1}, nil
	}}), nil)
	host := strings.TrimPrefix(server.URL, "http://")
	for _, tc := range []struct {
		headers map[string]string
		status  int
	}{
		{nil, 200},
		{map[string]string{"Origin": server.URL}, 200},
		{map[string]string{"Origin": "http://localhost:" + strings.Split(host, ":")[1]}, 200},
		{map[string]string{"Origin": "null"}, 403},
		{map[string]string{"Origin": ""}, 403},
		{map[string]string{"Origin": "https://" + host}, 403},
		{map[string]string{"Origin": "http://evil.test"}, 403},
		{map[string]string{"Origin": server.URL + "/"}, 403},
		{map[string]string{"Origin": server.URL + "?secret=1"}, 403},
		{map[string]string{"Origin": server.URL + "#fragment"}, 403},
		{map[string]string{"Origin": "http://user@" + host}, 403},
		{map[string]string{"Origin": server.URL + ", http://evil.test"}, 403},
		{map[string]string{"Origin": server.URL, "Sec-Fetch-Site": "cross-site"}, 200},
		{map[string]string{"Origin": "http://evil.test", "Sec-Fetch-Site": "same-origin"}, 403},
		{map[string]string{"Host": "evil.test:80", "X-Forwarded-Host": host}, 403},
		{map[string]string{"Host": "127.0.0.1:1"}, 403},
		{map[string]string{"Host": "localhost.evil.test:8080"}, 403},
		{map[string]string{"X-Forwarded-Host": "evil.test", "Forwarded": "host=evil.test"}, 200},
	} {
		response := post(t, server, noteCall, tc.headers)
		body := readBody(t, response)
		if response.StatusCode != tc.status {
			t.Fatalf("%+v: %d %s", tc.headers, response.StatusCode, body)
		}
		if response.Header.Get("Cache-Control") != "no-store, private" {
			t.Fatal("cache permitted")
		}
		if response.StatusCode == 200 && response.Header.Get("Content-Type") != "application/json" {
			t.Fatal("expected JSON")
		}
		if response.Header.Get("Mcp-Session-Id") != "" {
			t.Fatal("application session created")
		}
	}
	// Plusieurs Origin ne doivent pas être ramenés silencieusement au premier.
	request, _ := http.NewRequest("POST", server.URL, strings.NewReader(noteCall))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header["Origin"] = []string{server.URL, "http://evil.test"}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, response)
	if response.StatusCode != 403 {
		t.Fatal("multiple origins accepted")
	}
}

// TestAuthorityConfiguration impose des autorités locales explicites, sans joker ni port ambigu.
func TestAuthorityConfiguration(t *testing.T) {
	for _, values := range [][]string{nil, {}, {"*"}, {"localhost"}, {"localhost:0"}, {"localhost:08080"},
		{"0.0.0.0:8080"}, {"192.168.1.2:8080"}, {"evil.test:8080"}, {"localhost.:8080"}, {"localhost:65536"}} {
		if ValidateAuthorities(values) == nil {
			t.Fatalf("accepted %v", values)
		}
	}
	for _, values := range [][]string{{"localhost:8080"}, {"127.0.0.1:12345", "[::1]:12345"}, {"LOCALHOST:80"}} {
		if err := ValidateAuthorities(values); err != nil {
			t.Fatal(err)
		}
	}
}

// TestHTTPBodyBoundaries contrôle le même plafond pour les corps connus et chunked.
func TestHTTPBodyBoundaries(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{}), nil)
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	for _, chunked := range []bool{false, true} {
		for _, size := range []int{MaxRequestBytes - 1, MaxRequestBytes, MaxRequestBytes + 1} {
			t.Run(fmt.Sprintf("chunked=%t/bytes=%d", chunked, size), func(t *testing.T) {
				body := ping + strings.Repeat(" ", size-len(ping))
				request, _ := http.NewRequest("POST", server.URL, strings.NewReader(body))
				if chunked {
					request.ContentLength = -1
				}
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Accept", "application/json, text/event-stream")
				response, err := server.Client().Do(request)
				if err != nil {
					t.Fatal(err)
				}
				text := readBody(t, response)
				want := 200
				if size > MaxRequestBytes {
					want = 413
				}
				if response.StatusCode != want {
					t.Fatalf("%d: %s", response.StatusCode, text)
				}
			})
		}
	}
}

// TestDefaultResponseLimitCoversAllPayloads refuse aussi notes et métadonnées, sans fragments de contenu.
func TestDefaultResponseLimitCoversAllPayloads(t *testing.T) {
	huge := "PRIVATE-CONTENT" + strings.Repeat("x", MaxResultBytes/2)
	readers := stubReaders(readStub{
		note: func(context.Context, video.VideoID) (note.Note, error) {
			return note.Note{VideoID: 1, Revision: 1, ContentMD: huge}, nil
		},
		video: func(context.Context, video.VideoID) (video.Video, error) {
			return video.Video{ID: 1, Sources: []video.VideoSource{{ID: 1, Description: huge}}}, nil
		},
		transcript: func(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error) {
			return transcript.Result{Transcript: transcript.Transcript{ID: 1}, Content: transcript.TranscriptContent{{Text: huge}}}, nil
		},
	})
	_, server := endpoint(t, readers, nil)
	session := connect(t, server, "2026-07-28")
	for _, tool := range []string{"get_note", "get_video", "get_transcript"} {
		args := map[string]any{"video_id": 1}
		if tool == "get_transcript" {
			args["source_id"] = 1
			args["format"] = "timed"
		}
		result := call(t, session, tool, args)
		err := assertCode(t, result, "response_too_large")
		if err.LimitBytes != MaxResultBytes || err.SerializedBytes <= MaxResultBytes && err.SerializedBytesAtLeast <= MaxResultBytes {
			t.Fatal(err)
		}
		data, _ := json.Marshal(result)
		if bytes.Contains(data, []byte("PRIVATE-CONTENT")) {
			t.Fatal("partial payload")
		}
	}
}

// TestPositiveIDRetainsIntegerPrecision conserve MaxInt64 jusqu’au service applicatif.
func TestPositiveIDRetainsIntegerPrecision(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{video: func(_ context.Context, id video.VideoID) (video.Video, error) {
		if id != video.VideoID(math.MaxInt64) {
			t.Errorf("ID rounded: %d", id)
		}
		return video.Video{ID: id}, nil
	}}), nil)
	result := call(t, connect(t, server, "2026-07-28"), "get_video", json.RawMessage(`{"video_id":9223372036854775807}`))
	if result.IsError {
		t.Fatal(result)
	}
}

// TestTimeoutCancellationConcurrencyAndShutdown vérifie les lectures bornées et l’absence de travail orphelin.
func TestTimeoutCancellationConcurrencyAndShutdown(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25", "2025-06-18"} {
		t.Run(version, func(t *testing.T) {
			started := make(chan struct{}, MaxConcurrentReads)
			finished := make(chan struct{}, MaxConcurrentReads)
			block := func(ctx context.Context, _ video.VideoID) (note.Note, error) {
				started <- struct{}{}
				<-ctx.Done()
				finished <- struct{}{}
				return note.Note{}, ctx.Err()
			}
			h, server := endpoint(t, stubReaders(readStub{note: block}), nil)
			session := connect(t, server, version)
			completions := make(chan error, MaxConcurrentReads)
			for range MaxConcurrentReads {
				go func() {
					_, err := session.CallTool(context.Background(), &sdk.CallToolParams{Name: "get_note", Arguments: map[string]any{"video_id": 1}})
					completions <- err
				}()
			}
			for range MaxConcurrentReads {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("reads not started")
				}
			}
			response := post(t, server, noteCall, nil)
			readBody(t, response)
			if response.StatusCode != 503 || response.Header.Get("Retry-After") != "1" {
				t.Fatal("saturation not bounded")
			}
			closed := make(chan struct{})
			go func() { h.Close(); close(closed) }()
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("shutdown left handlers running")
			}
			for range MaxConcurrentReads {
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Fatal("orphaned read")
				}
				select {
				case <-completions:
				case <-time.After(time.Second):
					t.Fatal("orphaned client")
				}
			}
			response = post(t, server, noteCall, nil)
			readBody(t, response)
			if response.StatusCode != 503 {
				t.Fatal("accepted during shutdown")
			}
		})
		t.Run(version+"/deadline", func(t *testing.T) {
			_, server := endpoint(t, stubReaders(readStub{note: func(ctx context.Context, _ video.VideoID) (note.Note, error) {
				<-ctx.Done()
				return note.Note{}, ctx.Err()
			}}), func(h *Handler) { h.timeout = 50 * time.Millisecond })
			result := call(t, connect(t, server, version), "get_note", map[string]any{"video_id": 1})
			// Le contexte HTTP et le délai applicatif partagent le même budget.
			code := decode[struct{ Error errorDTO }](t, result).Error.Code
			if !result.IsError || code != "deadline_exceeded" {
				t.Fatal(result)
			}
		})
		t.Run(version+"/disconnect", func(t *testing.T) {
			started := make(chan struct{})
			finished := make(chan struct{})
			_, server := endpoint(t, stubReaders(readStub{note: func(ctx context.Context, _ video.VideoID) (note.Note, error) {
				close(started)
				<-ctx.Done()
				close(finished)
				return note.Note{}, ctx.Err()
			}}), nil)
			session := connect(t, server, version)
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() {
				_, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "get_note", Arguments: map[string]any{"video_id": 1}})
				done <- err
			}()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("not started")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("client did not cancel")
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("server read survived client cancellation")
			}
		})
	}
}

// TestSlowBodyKeepsTheToolError vérifie que la marge d'envoi ne remplace pas le budget d'entrée.
func TestSlowBodyKeepsTheToolError(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{note: func(ctx context.Context, _ video.VideoID) (note.Note, error) {
		<-ctx.Done()
		return note.Note{}, ctx.Err()
	}}), func(h *Handler) { h.timeout = 20 * time.Millisecond })
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	request, err := http.NewRequest("POST", server.URL, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	sent := make(chan error, 1)
	go func() {
		// Dépasser la seule marge d'envoi révélait une annulation prématurée du transport.
		time.Sleep(5100 * time.Millisecond)
		_, err := io.WriteString(writer, noteCall)
		writer.Close()
		sent <- err
	}()
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, response)
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Result struct {
			IsError           bool                     `json:"isError"`
			StructuredContent struct{ Error errorDTO } `json:"structuredContent"`
		}
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !envelope.Result.IsError || envelope.Result.StructuredContent.Error.Code != "deadline_exceeded" {
		t.Fatalf("tool deadline response lost: status=%d body=%s", response.StatusCode, body)
	}
}
