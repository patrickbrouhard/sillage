package ytdlp

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/video"
)

func TestParseMetadata(t *testing.T) {
	data, err := os.ReadFile("testdata/youtube.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseMetadata(data)
	if err != nil {
		t.Fatal(err)
	}
	duration := int64(10124)
	want := video.VideoSource{
		Provider: "youtube", ExternalID: "BaW_jenozKc",
		URL:         "https://www.youtube.com/watch?v=BaW_jenozKc",
		Title:       "Vidéo de test – Sillage",
		Description: "Première ligne.\nDeuxième ligne : été.",
		Creator:     "Chaîne de test", DurationMS: &duration,
		ThumbnailURL: "https://i.ytimg.com/vi/BaW_jenozKc/hqdefault.jpg",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestParseMetadataOptionalFields(t *testing.T) {
	for _, tc := range []struct {
		name         string
		fields       string
		wantDuration *int64
		wantCreator  string
	}{
		{name: "missing"},
		{name: "null", fields: `,"duration":null,"description":null,"channel":null,"thumbnail":null`},
		{name: "zero", fields: `,"duration":0`, wantDuration: new(int64)},
		{name: "uploader fallback", fields: `,"channel":"  ","uploader":" Auteur "`, wantCreator: "Auteur"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseMetadata([]byte(`{"extractor_key":"Youtube","id":"abc","title":"Titre"` + tc.fields + `}`))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.DurationMS, tc.wantDuration) || got.Creator != tc.wantCreator {
				t.Fatalf("unexpected optional metadata: %#v", got)
			}
		})
	}
}

func TestParseMetadataInvalid(t *testing.T) {
	for _, tc := range []struct{ name, data string }{
		{"empty", ""},
		{"malformed", "{"},
		{"null", "null"},
		{"array", "[]"},
		{"multiple objects", "{} {}"},
		{"playlist", `{"_type":"playlist","extractor_key":"Youtube","id":"abc","title":"Titre"}`},
		{"other provider", `{"extractor_key":"Vimeo","id":"abc","title":"Titre"}`},
		{"missing provider", `{"id":"abc","title":"Titre"}`},
		{"missing ID", `{"extractor_key":"Youtube","title":"Titre"}`},
		{"blank title", `{"extractor_key":"Youtube","id":"abc","title":" "}`},
		{"negative duration", `{"extractor_key":"Youtube","id":"abc","title":"Titre","duration":-0.0001}`},
		{"overflow", `{"extractor_key":"Youtube","id":"abc","title":"Titre","duration":1e20}`},
		{"wrong duration type", `{"extractor_key":"Youtube","id":"abc","title":"Titre","duration":"10"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseMetadata([]byte(tc.data))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !reflect.DeepEqual(got, video.VideoSource{}) {
				t.Fatalf("partial result on error: %#v", got)
			}
		})
	}
}

func TestNormalizedOutputExcludesRawMetadata(t *testing.T) {
	data, err := os.ReadFile("testdata/youtube.json")
	if err != nil {
		t.Fatal(err)
	}
	source, err := parseMetadata(data)
	if err != nil {
		t.Fatal(err)
	}
	output, err := json.Marshal(video.Video{Sources: []video.VideoSource{source}})
	if err != nil {
		t.Fatal(err)
	}
	var result struct{ Sources []map[string]json.RawMessage }
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"formats", "automatic_captions", "upload_date", "raw_metadata", "extractor_key", "tags"} {
		if _, exists := result.Sources[0][key]; exists {
			t.Errorf("unexpected field %q", key)
		}
	}
}
