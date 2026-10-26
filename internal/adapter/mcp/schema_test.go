package mcp

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// TestOutputSchemaRejectsInvalidSuccess vérifie les contrats publiés, y compris les branches exclusives.
func TestOutputSchemaRejectsInvalidSuccess(t *testing.T) {
	schema, err := jsonschema.For[transcriptDTO](nil)
	if err != nil {
		t.Fatal(err)
	}
	constrainOutput(schema)
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	base := `{"video_id":1,"source_id":2,"transcript_id":3,"language":"fr","provenance":"local","last_fetched_at":"2026-01-01T00:00:00Z","format":"text","complete":true,"text":""}`
	for _, tc := range []struct{ name, old, replacement string }{
		{"missing", `,"text":""`, ""},
		{"double", `"text":""`, `"text":"","fragments":[]`},
		{"wrong_text", `"format":"text"`, `"format":"timed"`},
		{"null_fragment_text", `"format":"text","complete":true,"text":""`, `"format":"timed","complete":true,"fragments":[{"start_ms":0,"text":null}]`},
		{"null_text", `"text":""`, `"text":null`},
		{"null_fragments", `"format":"text","complete":true,"text":""`, `"format":"timed","complete":true,"fragments":null`},
		{"wrong_timed", `"text":""`, `"fragments":[]`},
		{"zero_video", `"video_id":1`, `"video_id":0`},
		{"negative_source", `"source_id":2`, `"source_id":-1`},
		{"zero_transcript", `"transcript_id":3`, `"transcript_id":0`},
		{"incomplete", `"complete":true`, `"complete":false`},
		{"negative_timestamp", `"format":"text","complete":true,"text":""`, `"format":"timed","complete":true,"fragments":[{"start_ms":-1,"text":""}]`},
		{"bad_date", "2026-01-01T00:00:00Z", "2026-02-30T00:00:00Z"},
		{"not_utc", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00+01:00"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if validateOutput([]byte(strings.Replace(base, tc.old, tc.replacement, 1)), resolved) == nil {
				t.Fatal("invalid success accepted")
			}
		})
	}
	if err := validateOutput([]byte(base), resolved); err != nil {
		t.Fatal(err)
	}
	timed := strings.Replace(base, `"format":"text","complete":true,"text":""`, `"format":"timed","complete":true,"fragments":[{"start_ms":2,"text":" "},{"start_ms":2,"text":""},{"start_ms":0,"text":"fin"}]`, 1)
	if err := validateOutput([]byte(timed), resolved); err != nil {
		t.Fatal("original order rejected:", err)
	}
}

// TestNestedOutputConstraints couvre les identités, dates et durées des sources imbriquées.
func TestNestedOutputConstraints(t *testing.T) {
	schema, _ := jsonschema.For[videoDTO](nil)
	constrainOutput(schema)
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	base := `{"id":9223372036854775807,"created_at":"2026-01-01T00:00:00Z","sources":[{"id":2,"provider":"local","external_id":"","title":"","publisher":{"id":3,"provider":"","external_id":"","name":"","person_id":4},"duration_ms":null,"original_audio_language":"","description":""}],"tags":[{"id":5,"name":""}],"person_ids":[6]}`
	if err := validateOutput([]byte(base), resolved); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{
		{`"id":9223372036854775807`, `"id":0`},
		{`"id":2`, `"id":0`},
		{`"id":3`, `"id":-1`},
		{`"id":5`, `"id":0`},
		{`"person_id":4`, `"person_id":0`},
		{`"person_ids":[6]`, `"person_ids":[-1]`},
		{`"duration_ms":null`, `"duration_ms":-1`},
		{"2026-01-01T00:00:00Z", "not a date"},
	} {
		if validateOutput([]byte(strings.Replace(base, pair[0], pair[1], 1)), resolved) == nil {
			t.Fatalf("accepted %s", pair[1])
		}
	}
	schema, _ = jsonschema.For[searchDTO](nil)
	constrainOutput(schema)
	resolved, err = schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	validSearch := `{"results":[{"video":{"id":1,"created_at":"2026-01-01T00:00:00Z","sources":[],"tags":[]},"note_excerpt":[],"source_matches":[{"source_id":2,"title":true,"description":false,"publisher":false}]}],"page":1,"total":1,"has_more":false}`
	if err := validateOutput([]byte(validSearch), resolved); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{
		{"2026-01-01T00:00:00Z", "yesterday"},
		{`"source_id":2`, `"source_id":0`},
		{`"id":1`, `"id":0`},
	} {
		if validateOutput([]byte(strings.Replace(validSearch, pair[0], pair[1], 1)), resolved) == nil {
			t.Fatal("invalid nested search output accepted")
		}
	}
	for _, data := range []string{
		`{"results":[],"page":0,"total":0,"has_more":false}`,
		`{"results":[],"page":1001,"total":0,"has_more":false}`,
		`{"results":[],"page":1,"total":-1,"has_more":false}`,
	} {
		if validateOutput([]byte(data), resolved) == nil {
			t.Fatal("invalid page accepted")
		}
	}
}

// TestInvalidServiceOutputIsSafe vérifie que les détails d'un défaut interne ne sont jamais publiés.
func TestInvalidServiceOutputIsSafe(t *testing.T) {
	_, server := endpoint(t, stubReaders(readStub{note: func(context.Context, video.VideoID) (note.Note, error) {
		return note.Note{VideoID: 0, Revision: 1, ContentMD: "PRIVATE-SERVICE-DATA"}, nil
	}}), nil)
	result := call(t, connect(t, server, "2026-07-28"), "get_note", map[string]any{"video_id": 1})
	assertCode(t, result, "internal_error")
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "PRIVATE-SERVICE-DATA") {
		t.Fatal("validation leaked private content")
	}
}

// TestInt64OutputSurvivesValidation contrôle la représentation brute, sans décodage float64 du client.
func TestInt64OutputSurvivesValidation(t *testing.T) {
	recorder := &wireRecorder{}
	_, server := endpoint(t, stubReaders(readStub{video: func(context.Context, video.VideoID) (video.Video, error) {
		return video.Video{ID: video.VideoID(math.MaxInt64)}, nil
	}}), nil)
	recorder.base = server.Client().Transport
	result := call(t, connectEndpoint(t, &http.Client{Transport: recorder}, server.URL, "2026-07-28"), "get_video", map[string]any{"video_id": 1})
	if result.IsError {
		t.Fatal(result)
	}
	raw, _ := recorder.snapshot()
	if !strings.Contains(string(raw), `"id":9223372036854775807`) {
		t.Fatal("output ID rounded")
	}
}
