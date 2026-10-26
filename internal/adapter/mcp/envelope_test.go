package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// TestGeneratedOutputSchemasValidateActualResults confronte les schémas annoncés aux services réels et à une note vide.
func TestGeneratedOutputSchemasValidateActualResults(t *testing.T) {
	lib := testLibrary(t)
	v := lib.create(t, time.Now(), video.VideoSource{Provider: "youtube", ExternalID: "test", Title: "Kubernetes"})
	if _, err := lib.notes.Save(context.Background(), v.ID, "", 0); err != nil {
		t.Fatal(err)
	}
	lib.store(t, v.Sources[0].ID, "fr", `{"events":[{"tStartMs":0,"segs":[{"utf8":"Bonjour"}]}]}`, time.Now())
	_, server := endpoint(t, lib.readers, nil)
	session := connect(t, server, "2026-07-28")
	listed, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		data, err := json.Marshal(tool.OutputSchema)
		if err != nil {
			t.Fatal(err)
		}
		var schema jsonschema.Schema
		if err := json.Unmarshal(data, &schema); err != nil {
			t.Fatal(err)
		}
		resolved, err := schema.Resolve(nil)
		if err != nil {
			t.Fatal(err)
		}
		args := map[string]any{"video_id": v.ID}
		if tool.Name == "search_videos" {
			args = map[string]any{"query": "Kubernetes"}
		}
		if tool.Name == "get_transcript" {
			args["source_id"] = v.Sources[0].ID
		}
		result := call(t, session, tool.Name, args)
		if result.IsError {
			t.Fatal(result)
		}
		value := result.StructuredContent
		if err := resolved.Validate(&value); err != nil {
			t.Fatalf("%s output violates published schema: %v", tool.Name, err)
		}
		if tool.Name == "get_note" {
			text := result.Content[0].(*sdk.TextContent).Text
			if !strings.Contains(text, `"content_md":""`) {
				t.Fatal("empty note lost")
			}
		}
		if tool.Name == "get_transcript" {
			args["format"] = "timed"
			timed := call(t, session, tool.Name, args)
			value = timed.StructuredContent
			if err := resolved.Validate(&value); err != nil {
				t.Fatal(err)
			}
		}
	}
}
