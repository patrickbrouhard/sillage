package http

import (
	"crypto/rand"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"log"
	"log/slog"
	"net/http"
	"strings"
)

// WithLogging couvre API et SPA, sans lire ni retenir les corps des échanges.
// Chi préserve les interfaces de flush, hijack, push et copie du writer sous-jacent.
func WithLogging(logger *slog.Logger, next http.Handler) http.Handler {
	completed := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		requestlog.Complete(r)
	})
	logged := middleware.RequestLogger(requestlog.Formatter{})(middleware.Recoverer(completed))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := rand.Text()
		ctx := logging.WithRequest(r.Context(), id)
		ctx = logging.WithLogger(ctx, logger.With("http_request_id", id))
		w.Header().Set("X-Request-ID", id)
		logged.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ServerErrorLog protège aussi les diagnostics de net/http hors handler.
func ServerErrorLog(logger *slog.Logger) *log.Logger {
	return log.New(serverErrorWriter{logger}, "", 0)
}

type serverErrorWriter struct{ logger *slog.Logger }

func (w serverErrorWriter) Write(data []byte) (int, error) {
	reason := "transport_error"
	if strings.Contains(string(data), "TLS handshake error") {
		reason = "tls_handshake_failed"
	}
	w.logger.Error("HTTP transport failed", "event", "http.transport_failed", "reason", reason)
	return len(data), nil
}
