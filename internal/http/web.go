package http

import (
	"bytes"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// NewWebHandler compose l'API et le build SPA sans exposer les données du serveur.
// Le filesystem doit être restreint au build frontend ; les liens sortants
// doivent être interdits par l'appelant, par exemple avec os.OpenRoot.
func NewWebHandler(api http.Handler, files fs.FS) (http.Handler, error) {
	index, err := fs.ReadFile(files, "index.html")
	if err != nil {
		return nil, fmt.Errorf("read frontend index: %w", err)
	}
	static := http.FileServerFS(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Toute la famille API reste au routeur, y compris ses erreurs 404/405.
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		// Ne pas nettoyer un chemin invalide en le transformant en ressource valide.
		if name != "" && !fs.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		if name == "" || name == "index.html" {
			serveIndex(w, r, index)
			return
		}
		if info, err := fs.Stat(files, name); err == nil && info.Mode().IsRegular() {
			w.Header().Set("Cache-Control", "no-cache")
			// Vite réserve assets/ aux fichiers générés avec empreinte de contenu.
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			static.ServeHTTP(w, r)
			return
		}
		// Un asset manquant ou une demande de fichier ne devient jamais du HTML.
		if name == "assets" || strings.HasPrefix(name, "assets/") ||
			path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		// Les chemins de navigation sont résolus côté React ; aucun listing de dossier.
		serveIndex(w, r, index)
	}), nil
}

// serveIndex impose une revalidation pour ne pas conserver les anciennes références d'assets.
func serveIndex(w http.ResponseWriter, r *http.Request, index []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
}
