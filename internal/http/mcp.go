package http

import (
	"net/http"
	"strings"

	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
)

// WithMCP réserve /mcp avant la SPA, même lorsque le transport est désactivé.
// Les sous-chemins ne constituent pas des routes MCP et ne deviennent jamais index.html.
func WithMCP(next, transport http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" && !strings.HasPrefix(r.URL.Path, "/mcp/") {
			next.ServeHTTP(w, r)
			return
		}
		requestlog.Route(r, "/mcp")
		w.Header().Set("Cache-Control", "no-store, private")
		if transport == nil || r.URL.Path != "/mcp" {
			http.NotFound(w, r)
			return
		}
		transport.ServeHTTP(w, r)
	})
}
