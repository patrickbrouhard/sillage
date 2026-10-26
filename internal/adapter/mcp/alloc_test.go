package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// allocationFixture fabrique les données avant mesure : le stockage applicatif est exclu.
func allocationFixture(kind, profile string) (Readers, string, string, bool) {
	text := strings.Repeat("Kubernetes, déploiements et capacités. ", 700)
	if profile == "long" {
		text = strings.Repeat("Kubernetes capacity. ", 25000)
	}
	if profile == "escaped" {
		text = strings.Repeat("\x00<>&\"\\\n東京", 15000)
	}
	oversized := profile == "oversized"
	if oversized {
		text = strings.Repeat("\x00<>&\"\\\n東京", 400000)
	}
	tool, args := "get_note", `{"video_id":1}`
	stub := readStub{}
	switch kind {
	case "note":
		stub.note = func(context.Context, video.VideoID) (note.Note, error) {
			return note.Note{VideoID: 1, Revision: 1, ContentMD: text}, nil
		}
	case "metadata":
		tool = "get_video"
		stub.video = func(context.Context, video.VideoID) (video.Video, error) {
			return video.Video{ID: 1, Sources: []video.VideoSource{{ID: 1, Title: "Kubernetes", Description: text}}}, nil
		}
	default:
		tool = "get_transcript"
		args = fmt.Sprintf(`{"video_id":1,"source_id":1,"format":%q}`, kind)
		// Un contenu réaliste contient plusieurs fragments, pas une chaîne unique artificielle.
		content := make(transcript.TranscriptContent, 240)
		// Le découpage en runes préserve les caractères aux frontières des fragments.
		runes := []rune(text)
		chunk := len(runes) / len(content)
		for i := range content {
			end := (i + 1) * chunk
			if i == len(content)-1 {
				end = len(runes)
			}
			content[i] = transcript.TranscriptItem{StartMS: int64(i) * 5000, Text: string(runes[i*chunk : end])}
		}
		stub.transcript = func(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error) {
			return transcript.Result{Transcript: transcript.Transcript{ID: 1, Language: "fr", Provenance: "fixture"}, Content: content}, nil
		}
	}
	return stubReaders(stub), tool, args, oversized
}

// benchmarkSession utilise le véritable client SDK ; ses allocations sont donc incluses.
func benchmarkSession(b *testing.B, readers Readers) (*sdk.ClientSession, *atomic.Int64) {
	b.Helper()
	server := httptest.NewUnstartedServer(nil)
	handler, err := New(context.Background(), readers, []string{server.Listener.Addr().String()})
	if err != nil {
		b.Fatal(err)
	}
	server.Config.Handler = handler
	server.Start()
	b.Cleanup(func() { handler.Close(); server.Close() })
	wireBytes := &atomic.Int64{}
	clientHTTP := server.Client()
	clientHTTP.Transport = &benchmarkTransport{base: clientHTTP.Transport, bytes: wireBytes}
	client := sdk.NewClient(
		&sdk.Implementation{Name: "allocation-test", Version: "1"},
		&sdk.ClientOptions{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))},
	)
	session, err := client.Connect(
		context.Background(),
		&sdk.StreamableClientTransport{
			Endpoint:             server.URL,
			HTTPClient:           clientHTTP,
			DisableStandaloneSSE: true,
			MaxRetries:           -1,
		},
		&sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"},
	)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { session.Close() })
	return session, wireBytes
}

// BenchmarkMCPHTTP mesure les allocations cumulées serveur et client SDK, hors fixtures.
// Le volume transmis comprend le corps HTTP et son enveloppe JSON-RPC.
func BenchmarkMCPHTTP(b *testing.B) {
	for _, kind := range []string{"text", "timed", "note", "metadata"} {
		for _, profile := range []string{"normal", "long", "escaped", "oversized"} {
			b.Run(kind+"/"+profile, func(b *testing.B) {
				readers, tool, args, oversized := allocationFixture(kind, profile)
				session, wireBytes := benchmarkSession(b, readers)
				params := &sdk.CallToolParams{Name: tool, Arguments: json.RawMessage(args)}
				invoke := func() *sdk.CallToolResult {
					result, err := session.CallTool(context.Background(), params)
					if err != nil {
						b.Fatal(err)
					}
					if result.IsError != oversized {
						b.Fatal("unexpected tool outcome")
					}
					return result
				}
				wireBytes.Store(0)
				check := invoke()
				transmitted := wireBytes.Load()
				if oversized {
					data, _ := json.Marshal(check.StructuredContent)
					var envelope struct{ Error errorDTO }
					if json.Unmarshal(data, &envelope) != nil || envelope.Error.Code != "response_too_large" {
						b.Fatal("wrong rejection")
					}
				}
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					invoke()
				}
				b.StopTimer()
				b.ReportMetric(float64(transmitted), "wire-B/op")
			})
		}
	}
}

// BenchmarkMCPFourConcurrent caractérise quatre réponses échappées simultanées, sans lots.
func BenchmarkMCPFourConcurrent(b *testing.B) {
	readers, _, args, _ := allocationFixture("timed", "escaped")
	session, _ := benchmarkSession(b, readers)
	params := &sdk.CallToolParams{Name: "get_transcript", Arguments: json.RawMessage(args)}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var group sync.WaitGroup
		failures := make(chan error, 4)
		for range 4 {
			group.Add(1)
			go func() {
				defer group.Done()
				result, err := session.CallTool(context.Background(), params)
				if err == nil && result.IsError {
					err = fmt.Errorf("unexpected tool error")
				}
				if err != nil {
					failures <- err
				}
			}()
		}
		group.Wait()
		close(failures)
		for err := range failures {
			b.Fatal(err)
		}
	}
}

// TestPreflightIsConservative protège le sens de serialized_bytes_at_least, y compris les échappements.
func TestPreflightIsConservative(t *testing.T) {
	text := "東京\x00\n\"\\<>&\u2028"
	for _, value := range []any{
		noteDTO{VideoID: 1, ContentMD: text},
		transcriptDTO{Text: &text},
		transcriptDTO{Fragments: &[]fragmentDTO{{StartMS: 0, Text: text}, {StartMS: 0, Text: " "}}},
		videoDTO{Tags: []tagDTO{{ID: 1, Name: ""}}, PersonIDs: []video.PersonID{1, 2}, Sources: []fullSourceDTO{{sourceDTO: sourceDTO{ID: 1, Title: text}, Description: text}}},
		searchDTO{Results: []searchResultDTO{{Video: compactVideoDTO{Sources: []sourceDTO{{ID: 1, Title: text}}}}}},
	} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		final, err := json.Marshal(contentResult(data))
		if err != nil {
			t.Fatal(err)
		}
		if bound := payloadLowerBound(value, MaxResultBytes); bound > len(final) {
			t.Fatalf("lower bound=%d exceeds actual=%d", bound, len(final))
		}
	}
}

// benchmarkTransport compte les octets sans recopier le corps des réponses.
type benchmarkTransport struct {
	base  http.RoundTripper
	bytes *atomic.Int64
}

// RoundTrip conserve la pile HTTP réelle et ajoute seulement un compteur de lecture.
func (t *benchmarkTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(r)
	if err == nil {
		response.Body = &benchmarkBody{ReadCloser: response.Body, bytes: t.bytes}
	}
	return response, err
}

type benchmarkBody struct {
	io.ReadCloser
	bytes *atomic.Int64
}

// Read compte les octets reçus, y compris les champs ajoutés par le SDK.
func (b *benchmarkBody) Read(data []byte) (int, error) {
	n, err := b.ReadCloser.Read(data)
	b.bytes.Add(int64(n))
	return n, err
}

// TestPlainTextPreflightRemainsALowerBound vérifie que les blancs et Unicode ne provoquent pas de refus fictif.
func TestPlainTextPreflightRemainsALowerBound(t *testing.T) {
	for _, content := range []transcript.TranscriptContent{
		{{Text: "  \t\n"}}, {{Text: "東京\u2003🦊"}}, {{Text: "ab "}, {Text: " cd\n"}},
		{{Text: string([]byte{0xe6})}, {Text: string([]byte{0x9d, 0xb1})}},
		{{Text: "<>&\x00\"\\"}}, {{Text: "\u00a0a\t b\u2028 c"}},
	} {
		out := transcriptDTO{Text: ptr(content.PlainText())}
		data, _ := json.Marshal(out)
		final, _ := json.Marshal(contentResult(data))
		if bound := transcriptTextLowerBound(content, MaxResultBytes); bound > len(final) {
			t.Fatalf("bound=%d actual=%d", bound, len(final))
		}
	}
}

// BenchmarkOversizedPlainText isole le coût CPU/mémoire évité avant la normalisation complète.
// Les fixtures sont chargées avant mesure ; aucun changement du service PlainText n’est nécessaire.
func BenchmarkOversizedPlainText(b *testing.B) {
	readers, _, _, _ := allocationFixture("text", "oversized")
	result, err := readers.Transcripts.Get(context.Background(), 1, 1)
	if err != nil {
		b.Fatal(err)
	}
	b.Run("normalization_only", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			benchmarkTextSink = result.Content.PlainText()
		}
	})
	b.Run("preflight_only", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			benchmarkBoundSink = transcriptTextLowerBound(result.Content, MaxResultBytes)
		}
	})
}

var benchmarkTextSink string
var benchmarkBoundSink int
