// Package requestlog rassemble le bilan HTTP sans exposer le transport aux services.
package requestlog

import (
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/patrickbrouhard/sillage/internal/logging"
)

// Formatter fournit à Chi une entrée structurée par requête.
type Formatter struct{}

// NewLogEntry est appelé après installation du logger corrélé.
func (Formatter) NewLogEntry(r *http.Request) middleware.LogEntry {
	return &Entry{request: r, route: "unmatched"}
}

// Entry appartient exclusivement à la goroutine du handler.
type Entry struct {
	request    *http.Request
	route      string
	code       string
	failure    slog.Attr
	complete   bool
	panicked   bool
	frames     []string
	attributes []slog.Attr
}

// Get retrouve l'entrée installée par RequestLogger, ou nil en test unitaire isolé.
func Get(r *http.Request) *Entry {
	entry, _ := middleware.GetLogEntry(r).(*Entry)
	return entry
}

// Route conserve uniquement un modèle fourni par le routeur ou une catégorie constante.
func Route(r *http.Request, pattern string) {
	if e := Get(r); e != nil && pattern != "" {
		e.route = pattern
	}
}

// Result associe au bilan un code applicatif constant et un diagnostic assaini.
func Result(r *http.Request, code string, err error) {
	if e := Get(r); e != nil {
		if code != "" {
			e.code = code
		}
		if err != nil {
			e.failure = logging.Error(err)
		}
	}
}

// Complete distingue une réponse implicite normale d'un abandon par panic.
func Complete(r *http.Request) {
	if e := Get(r); e != nil {
		e.complete = true
	}
}

// Panic garde les emplacements du code, jamais la valeur arbitraire du panic.
func (e *Entry) Panic(_ interface{}, stack []byte) {
	e.panicked = true
	for _, line := range strings.Split(string(stack), "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, ".go:") {
			location, _, _ := strings.Cut(line, " ")
			e.frames = append(e.frames, filepath.Base(location))
		}
	}
}

// Write émet le seul bilan ; un refus de capacité n'est pas une erreur serveur.
func (e *Entry) Write(status, bytes int, _ http.Header, elapsed time.Duration, _ interface{}) {
	level := slog.LevelInfo
	outcome := "completed"
	method := e.request.Method
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
	default:
		method = "OTHER"
	}
	if method == "GET" || method == "HEAD" || (method == "PUT" && strings.HasSuffix(e.route, "/note")) {
		level = slog.LevelDebug
	}
	if e.code == "response_write_failed" {
		level = slog.LevelWarn
	}
	if status >= 400 {
		level = slog.LevelWarn
	}
	if status >= 500 && e.code != "capture_busy" && e.code != "download_busy" {
		level = slog.LevelError
	}
	if e.request.Context().Err() != nil || (!e.complete && !e.panicked) {
		outcome = "aborted"
		// Une déconnexion ne doit pas effacer une erreur serveur déjà constatée.
		if level != slog.LevelError {
			level = slog.LevelDebug
		}
	} else if status == 0 {
		status = http.StatusOK
	}
	if e.panicked {
		// Le recoverer n'a pu écrire 500 : Chi avait déjà flushé un 200 implicite.
		if status == 0 {
			status = http.StatusOK
		}
		level = slog.LevelError
		outcome = "panic"
	}
	attrs := []slog.Attr{
		slog.String("event", "http.completed"), slog.String("component", "http"),
		slog.String("method", method), slog.String("route", e.route),
		slog.Int("status", status), slog.Int("response_bytes", bytes),
		slog.Int64("elapsed_ms", elapsed.Milliseconds()), slog.String("outcome", outcome),
	}
	attrs = append(attrs, e.attributes...)
	if e.code != "" {
		attrs = append(attrs, slog.String("error_code", e.code))
	}
	if e.failure.Key != "" {
		attrs = append(attrs, e.failure)
	}
	if e.panicked {
		attrs = append(attrs, slog.Any("frames", e.frames))
	}
	logging.From(e.request.Context()).LogAttrs(e.request.Context(), level, "HTTP request completed", attrs...)
}

// Fields ajoute uniquement des attributs contrôlés par les handlers ou le routeur.
func Fields(r *http.Request, attrs ...slog.Attr) {
	if e := Get(r); e != nil {
		e.attributes = append(e.attributes, attrs...)
	}
}
