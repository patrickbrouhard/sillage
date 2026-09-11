package handlers

import (
	"encoding/json"
	"github.com/patrickbrouhard/sillage/internal/video"
	"strings"
	"testing"
	"time"
)

func TestRepresentationPreservesZeroAndConvertsAbsentFields(t *testing.T) {
	zero := int64(0)
	v := video.Video{ID: 42, CreatedAt: time.Date(2026, 9, 10, 20, 30, 12, 123000000, time.FixedZone("Paris", 7200)),
		Sources: []video.VideoSource{{ID: 17, VideoID: 42, Provider: "youtube", Title: "title", DurationMS: &zero}}}
	data, err := json.Marshal(toVideoResponse(v))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":42,"created_at":"2026-09-10T18:30:12.123Z","sources":[{"id":17,"provider":"youtube","external_id":null,"canonical_url":null,"title":"title","description":null,"creator":null,"duration_ms":0,"thumbnail_url":null}]}`
	if string(data) != want {
		t.Fatalf("got %s", data)
	}
	data, err = json.Marshal(toVideoResponse(video.Video{}))
	if err != nil || !strings.Contains(string(data), `"sources":[]`) {
		t.Fatalf("%s %v", data, err)
	}
}
