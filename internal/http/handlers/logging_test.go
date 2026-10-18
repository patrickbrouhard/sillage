package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/logging"
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
