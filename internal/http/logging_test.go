package http

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/logging"
)

func logRows(t *testing.T, b *bytes.Buffer) []map[string]any {
	t.Helper()
	var rows []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.String()), "\n") {
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, row)
	}
	return rows
}

func TestHTTPLoggingIdentityLevelsAndPrivacy(t *testing.T) {
	var out bytes.Buffer
	logger, _ := logging.New(&out, "DEBUG", "json")
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestlog.Route(r, "/example/{id}")
		if r.Method == "POST" {
			requestlog.Result(r, "capture_busy", nil)
			w.WriteHeader(503)
			return
		}
		io.WriteString(w, "ok")
	})
	handler := WithLogging(logger, next)
	ids := map[string]bool{}
	for _, method := range []string{"GET", "POST"} {
		r := httptest.NewRequest(method, "/PRIVATE?secret=PRIVATE", nil)
		r.Header.Set("X-Request-ID", "PRIVATE")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		id := w.Header().Get("X-Request-ID")
		if id == "" || id == "PRIVATE" || ids[id] {
			t.Fatal(id)
		}
		ids[id] = true
	}
	rows := logRows(t, &out)
	if len(rows) != 2 || rows[0]["level"] != "DEBUG" || rows[1]["level"] != "WARN" {
		t.Fatal(rows)
	}
	for _, row := range rows {
		if !ids[row["http_request_id"].(string)] || row["route"] != "/example/{id}" {
			t.Fatal(row)
		}
	}
	if strings.Contains(out.String(), "PRIVATE") {
		t.Fatal("request data leaked")
	}
}

func TestHTTPLoggingPanicAndAbort(t *testing.T) {
	for _, abort := range []bool{false, true} {
		var out bytes.Buffer
		logger, _ := logging.New(&out, "DEBUG", "json")
		h := WithLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if abort {
				panic(http.ErrAbortHandler)
			}
			panic("PRIVATE")
		}))
		func() {
			defer func() {
				v := recover()
				if abort && v != http.ErrAbortHandler {
					t.Fatal(v)
				}
			}()
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
		}()
		rows := logRows(t, &out)
		if len(rows) != 1 || strings.Contains(out.String(), "PRIVATE") {
			t.Fatal(out.String())
		}
		if abort {
			if rows[0]["outcome"] != "aborted" || rows[0]["status"] != float64(0) {
				t.Fatal(rows)
			}
		} else if rows[0]["outcome"] != "panic" || rows[0]["status"] != float64(500) {
			t.Fatal(rows)
		}
	}
}

func TestHTTPLoggingPreservesHEADAndRange(t *testing.T) {
	var out bytes.Buffer
	logger, _ := logging.New(&out, "DEBUG", "json")
	h := WithLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "file.txt", time.Time{}, strings.NewReader("0123456789"))
	}))
	for _, tc := range []struct {
		method, rangeHeader, body string
		status                    int
	}{
		{"HEAD", "", "", 200}, {"GET", "bytes=2-5", "2345", 206}, {"GET", "bytes=20-30", "invalid range: failed to overlap\n", 416},
	} {
		r := httptest.NewRequest(tc.method, "/file", nil)
		r.Header.Set("Range", tc.rangeHeader)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status || w.Body.String() != tc.body {
			t.Fatalf("%d %q", w.Code, w.Body.String())
		}
		rows := logRows(t, &out)
		if rows[len(rows)-1]["status"] != float64(tc.status) {
			t.Fatal(rows)
		}
	}
}

func TestHTTPLoggingStreamsBeforeHandlerReturns(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	release := make(chan struct{})
	h := WithLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "first\n")
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Error(err)
		}
		<-release
		io.WriteString(w, "second\n")
	}))
	server := httptest.NewServer(h)
	defer server.Close()
	defer close(release)
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "first\n" {
		t.Fatal(line, err)
	}
}

func TestHTTPLoggingPreservesHijack(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(WithLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		rw.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
		rw.Flush()
	})))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	if string(body) != "ok" {
		t.Fatal(string(body))
	}
}

func TestHTTPLoggingCanceledRequest(t *testing.T) {
	var out bytes.Buffer
	logger, _ := logging.New(&out, "DEBUG", "json")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	WithLogging(logger, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil).WithContext(ctx))
	rows := logRows(t, &out)
	if len(rows) != 1 || rows[0]["outcome"] != "aborted" || rows[0]["status"] != float64(0) {
		t.Fatal(rows)
	}
}
