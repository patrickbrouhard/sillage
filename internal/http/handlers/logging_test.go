package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/patrickbrouhard/sillage/internal/asset"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

type brokenWriter struct{ header http.Header }

func (w brokenWriter) Header() http.Header       { return w.header }
func (w brokenWriter) WriteHeader(int)           {}
func (w brokenWriter) Write([]byte) (int, error) { return 0, errors.New("PRIVATE disconnected") }

func TestResponseFailuresHaveOneSafeSummary(t *testing.T) {
	for _, encodingFailure := range []bool{true, false} {
		var output bytes.Buffer
		logger, _ := logging.New(&output, "DEBUG", "json")
		ctx := logging.WithLogger(context.Background(), logger)
		handler := middleware.RequestLogger(requestlog.Formatter{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var value any = map[string]string{"result": "ok"}
			if encodingFailure {
				value = make(chan int)
			}
			writeJSON(w, r, 200, value)
			requestlog.Complete(r)
		}))
		var writer http.ResponseWriter = httptest.NewRecorder()
		if !encodingFailure {
			writer = brokenWriter{make(http.Header)}
		}
		handler.ServeHTTP(writer, httptest.NewRequest("GET", "/", nil).WithContext(ctx))
		decoder := json.NewDecoder(&output)
		var row map[string]any
		if err := decoder.Decode(&row); err != nil {
			t.Fatal(err)
		}
		if decoder.Decode(&map[string]any{}) != io.EOF {
			t.Fatal("duplicate summary")
		}
		if encodingFailure && (row["status"] != float64(500) || row["error_code"] != "response_encode_failed") {
			t.Fatal(row)
		}
		if !encodingFailure && (row["status"] != float64(200) || row["error_code"] != "response_write_failed") {
			t.Fatal(row)
		}
		data, _ := json.Marshal(row)
		if strings.Contains(string(data), "PRIVATE") {
			t.Fatal(string(data))
		}
	}
}

// TestBusinessAndTechnicalDiagnostics vérifie la politique sans changer les réponses REST.
func TestBusinessAndTechnicalDiagnostics(t *testing.T) {
	mediaError := func(w http.ResponseWriter, r *http.Request, err error) {
		respondMediaError(w, r, media.State{}, err)
	}
	for _, tc := range []struct {
		name, method, level, code, reason string
		status                            int
		err                               error
		respond                           func(http.ResponseWriter, *http.Request, error)
	}{
		{"note_absent", "GET", "DEBUG", "note_not_found", "", 404, note.ErrNotFound, respondKnowledgeError},
		{"transcript_absent", "GET", "DEBUG", "transcript_not_found", "", 404, transcript.ErrNotFound, respondTranscriptError},
		{"transcript_post", "POST", "WARN", "transcript_not_found", "", 404, transcript.ErrNotFound, respondTranscriptError},
		{"transcript_unavailable", "POST", "WARN", "transcript_not_available", "", 404, transcript.ErrNotAvailable, respondTranscriptError},
		{"note_conflict", "PUT", "WARN", "note_conflict", "", 409, note.ErrConflict, respondKnowledgeError},
		{"video_absent", "GET", "WARN", "video_not_found", "", 404, video.ErrVideoNotFound, respondError},
		{"person_absent", "GET", "WARN", "person_not_found", "", 404, video.ErrPersonNotFound, respondPeopleError},
		{"asset_busy", "POST", "WARN", "capture_busy", "", 503, asset.ErrBusy, respondAssetError},
		{"media_busy", "POST", "WARN", "download_busy", "", 503, media.ErrBusy, mediaError},
		{"asset_pending", "GET", "WARN", "asset_content_unavailable", "", 409, asset.ErrUnavailable, respondAssetError},
		{"media_unavailable", "GET", "WARN", "local_media_unavailable", "", 409, media.ErrUnavailable, mediaError},
		{"asset_disk", "GET", "WARN", "asset_content_unavailable", "permission_denied", 409,
			fmt.Errorf("%w: %w", asset.ErrUnavailable, &os.PathError{Op: "open", Path: "PRIVATE", Err: os.ErrPermission}), respondAssetError},
		{"media_disk", "GET", "WARN", "local_media_unavailable", "permission_denied", 409,
			fmt.Errorf("%w: %w", media.ErrUnavailable, &os.PathError{Op: "open", Path: "PRIVATE", Err: os.ErrPermission}), mediaError},
		{"timeout", "POST", "ERROR", "metadata_fetch_timeout", "timeout", 504, context.DeadlineExceeded, respondError},
		{"internal", "GET", "ERROR", "internal_error", "internal_error", 500, errors.New("PRIVATE SQL"), respondKnowledgeError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, canceled := range []bool{false, true} {
				var output bytes.Buffer
				logger, _ := logging.New(&output, "DEBUG", "json")
				ctx, cancel := context.WithCancel(logging.WithLogger(context.Background(), logger))
				if canceled {
					cancel()
				}
				handler := middleware.RequestLogger(requestlog.Formatter{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					tc.respond(w, r, tc.err)
					requestlog.Complete(r)
				}))
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(tc.method, "/", nil).WithContext(ctx))
				cancel()
				var row map[string]any
				decoder := json.NewDecoder(&output)
				if err := decoder.Decode(&row); err != nil {
					t.Fatal(err)
				}
				if decoder.Decode(&map[string]any{}) != io.EOF {
					t.Fatal("duplicate summary")
				}
				level := tc.level
				if canceled && level != "ERROR" {
					level = "DEBUG"
				}
				if row["level"] != level || row["error_code"] != tc.code {
					t.Fatal(row)
				}
				if canceled {
					if row["status"] != float64(0) || w.Body.Len() != 0 {
						t.Fatal(row, w.Body.String())
					}
				} else {
					var body struct{ Error struct{ Code string } }
					if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error.Code != tc.code || w.Code != tc.status {
						t.Fatal(w.Code, w.Body.String(), err)
					}
				}
				if tc.reason == "" {
					if row["error"] != nil {
						t.Fatal(row)
					}
				} else if diagnostic, ok := row["error"].(map[string]any); !ok || diagnostic["reason"] != tc.reason {
					t.Fatal(row)
				}
				encoded, _ := json.Marshal(row)
				if strings.Contains(string(encoded), "PRIVATE") {
					t.Fatal(row)
				}
			}
		})
	}
}

func TestCanceledServiceDoesNotBecomeInternalFailure(t *testing.T) {
	var output bytes.Buffer
	logger, _ := logging.New(&output, "INFO", "json")
	ctx, cancel := context.WithCancel(logging.WithLogger(context.Background(), logger))
	cancel()
	h := middleware.RequestLogger(requestlog.Formatter{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respondError(w, r, context.Canceled)
		requestlog.Complete(r)
	}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil).WithContext(ctx))
	if output.Len() != 0 || w.Body.Len() != 0 {
		t.Fatal(output.String(), w.Body.String())
	}
}
