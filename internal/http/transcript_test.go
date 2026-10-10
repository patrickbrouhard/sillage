package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type transcriptStub struct {
	fetch func(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error)
	get   func(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error)
}

func (s transcriptStub) Fetch(ctx context.Context, v video.VideoID, id video.VideoSourceID) (transcript.Result, error) {
	return s.fetch(ctx, v, id)
}
func (s transcriptStub) Get(ctx context.Context, v video.VideoID, id video.VideoSourceID) (transcript.Result, error) {
	return s.get(ctx, v, id)
}

func TestTranscriptHTTPValidationAndErrors(t *testing.T) {
	path := "/api/v1/videos/1/sources/2/transcript"
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{video.ErrInvalidInput, 400, "bad_request"},
		{video.ErrVideoNotFound, 404, "video_not_found"},
		{video.ErrVideoSourceNotFound, 404, "video_source_not_found"},
		{transcript.ErrNotFound, 404, "transcript_not_found"},
		{transcript.ErrNotAvailable, 404, "transcript_not_available"},
		{transcript.ErrFetchFailed, 502, "transcript_fetch_failed"},
		{context.DeadlineExceeded, 504, "transcript_fetch_timeout"},
		{os.ErrNotExist, 500, "internal_error"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			fail := func(context.Context, video.VideoID, video.VideoSourceID) (transcript.Result, error) {
				return transcript.Result{}, fmt.Errorf("private diagnostic: %w", tc.err)
			}
			handler := api.NewRouter(nil, nil, nil, nil, transcriptStub{fetch: fail, get: fail}, nil, time.Second)
			for _, method := range []string{"GET", "POST"} {
				assertError(t, request(handler, method, path, "", ""), tc.status, tc.code)
			}
		})
	}
	handler := api.NewRouter(nil, nil, nil, nil, transcriptStub{}, nil, time.Second)
	for _, ids := range []string{"0/sources/2", "1/sources/-1", "abc/sources/2", "1/sources/9223372036854775808"} {
		for _, method := range []string{"GET", "POST"} {
			assertError(t, request(handler, method, "/api/v1/videos/"+ids+"/transcript", "", ""), 400, "bad_request")
		}
	}
	for _, body := range []string{"{}", " ", `{"language":"en"}`} {
		assertError(t, request(handler, "POST", path, body, "application/json"), 400, "bad_request")
	}
}

func TestTranscriptHTTPTimeoutAndCancellation(t *testing.T) {
	service := transcriptStub{fetch: func(ctx context.Context, _ video.VideoID, _ video.VideoSourceID) (transcript.Result, error) {
		<-ctx.Done()
		return transcript.Result{}, ctx.Err()
	}}
	handler := api.NewRouter(nil, nil, nil, nil, service, nil, 10*time.Millisecond)
	path := "/api/v1/videos/1/sources/2/transcript"
	assertError(t, request(handler, "POST", path, "", ""), 504, "transcript_fetch_timeout")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("POST", path, nil).WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Body.Len() != 0 || len(w.Header()) != 0 {
		t.Fatal("response sent to canceled client")
	}
}

func TestTranscriptHTTPExecutableToSQLite(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "sillage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	videos := sqlite.NewVideoRepository(db)
	v, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "abc", Title: "Title"}}})
	if err != nil {
		t.Fatal(err)
	}
	other, err := videos.Create(ctx, video.Video{CreatedAt: time.Now(), Sources: []video.VideoSource{{Provider: "youtube", ExternalID: "other", Title: "Other"}}})
	if err != nil {
		t.Fatal(err)
	}
	// Ce script ne simule que les deux commandes de cette acquisition de test.
	binary := filepath.Join(root, "yt-dlp")
	script := `#!/bin/sh
for arg in "$@"; do
 if [ "$arg" = "--dump-single-json" ]; then
  printf '%s' '{"extractor_key":"Youtube","id":"abc","title":"Title","automatic_captions":{"en-orig":[{"ext":"json3","url":"https://example.test/en"}]}}'
  exit 0
 fi
done
while [ "$#" -gt 0 ]; do
 if [ "$1" = "--output" ]; then output="$2"; shift; fi
 shift
done
test -n "$output" || exit 2
printf '%s' '{"events":[{"tStartMs":2960,"segs":[{"utf8":"This"},{"tOffsetMs":120,"utf8":" is"}]}]}' > "$(dirname "$output")/caption.en-orig.json3"
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	repo := sqlite.NewTranscriptRepository(db)
	snapshots := filesystem.NewTranscripts(filepath.Join(root, "snapshots"), ytdlp.ParseJSON3)
	service := transcript.NewService(videos, repo, ytdlp.Client{Binary: binary}, snapshots)
	notes := note.NewService(sqlite.NewNoteRepository(db))
	tags := video.NewTagService(sqlite.NewTagRepository(db))
	savedNote, err := notes.Save(ctx, v.ID, "  Notes personnelles\r\n")
	if err != nil {
		t.Fatal(err)
	}
	savedTags, err := tags.Add(ctx, v.ID, []string{"Personnel"})
	if err != nil {
		t.Fatal(err)
	}
	handler := api.NewRouter(nil, nil, notes, tags, service, video.NewService(videos, ytdlp.Client{Binary: binary}), time.Second)
	path := fmt.Sprintf("/api/v1/videos/%d/sources/%d/transcript", v.ID, v.Sources[0].ID)
	wrongPath := fmt.Sprintf("/api/v1/videos/%d/sources/%d/transcript", other.ID, v.Sources[0].ID)
	for _, method := range []string{"GET", "POST"} {
		assertError(t, request(handler, method, wrongPath, "", ""), 404, "video_source_not_found")
	}
	assertError(t, request(handler, "GET", path, "", ""), 404, "transcript_not_found")
	for range 2 {
		post := request(handler, "POST", path, "", "")
		if post.Code != 200 || post.Header().Get("Location") != "" {
			t.Fatalf("%d %s", post.Code, post.Body.String())
		}
		get := request(handler, "GET", path, "", "")
		if get.Code != 200 || post.Body.String() != get.Body.String() {
			t.Fatalf("%s / %s", post.Body.String(), get.Body.String())
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(get.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body) != 4 || string(body["language"]) != `"en"` || string(body["provenance"]) != `"youtube_auto"` {
			t.Fatal(body)
		}
		if string(body["items"]) != `[{"start_ms":2960,"text":"This"},{"start_ms":3080,"text":" is"}]` {
			t.Fatal(string(body["items"]))
		}
	}
	stored, err := repo.Latest(ctx, v.Sources[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	before := request(handler, "GET", path, "", "").Body.String()
	// Le GET reste identique avec un exécutable distant devenu indisponible.
	if err := os.Remove(binary); err != nil {
		t.Fatal(err)
	}
	get := request(handler, "GET", path, "", "")
	if get.Code != 200 || get.Body.String() != before {
		t.Fatal(get.Body.String())
	}
	assertError(t, request(handler, "POST", path, "", ""), 500, "internal_error")
	after, err := repo.Latest(ctx, v.Sources[0].ID)
	if err != nil || after != stored {
		t.Fatal(after, err)
	}
	if err := os.WriteFile(filepath.Join(root, "snapshots", stored.LocalPath), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	assertError(t, request(handler, "GET", path, "", ""), 500, "internal_error")
	detail := request(handler, "GET", fmt.Sprintf("/api/v1/videos/%d", v.ID), "", "")
	if detail.Code != 200 || strings.Contains(detail.Body.String(), "original_audio_language") {
		t.Fatal(detail.Body.String())
	}
	if _, err := repo.Latest(ctx, 999); !errors.Is(err, transcript.ErrNotFound) {
		t.Fatal(err)
	}
	// Les acquisitions réussies et échouées ne doivent pas toucher aux données utilisateur.
	gotNote, err := notes.Get(ctx, v.ID)
	if err != nil || gotNote != savedNote.Note {
		t.Fatalf("note changed: %+v %v", gotNote, err)
	}
	gotVideo, err := videos.Get(ctx, v.ID)
	if err != nil || len(gotVideo.Tags) != 1 || gotVideo.Tags[0] != savedTags[0] {
		t.Fatalf("tags changed: %+v %v", gotVideo.Tags, err)
	}
}
