package http

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/patrickbrouhard/sillage/internal/auth"
	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"golang.org/x/time/rate"
)

// AuthHandler applique les sessions et le CSRF à toutes les routes privées.
type AuthHandler struct {
	service     *auth.Service
	origin      string
	host        string
	secure      bool
	cookieName  string
	preauthName string
	secret      []byte
	limiter     *rate.Limiter
	hashing     chan struct{}
	next        http.Handler
}

// WithAuthentication protège les données ; seuls le shell statique et les routes de connexion sont publics.
func WithAuthentication(next http.Handler, service *auth.Service, publicURL string) (http.Handler, error) {
	u, err := url.Parse(publicURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("invalid SILLAGE_PUBLIC_URL: expected an HTTP(S) origin")
	}
	h := &AuthHandler{
		service:     service,
		origin:      u.Scheme + "://" + u.Host,
		host:        u.Host,
		secure:      u.Scheme == "https",
		cookieName:  "sillage_session",
		preauthName: "sillage_login",
		secret:      make([]byte, 32),
		limiter:     rate.NewLimiter(2, 10),
		hashing:     make(chan struct{}, 2),
		next:        next,
	}
	if h.secure {
		h.cookieName = "__Host-sillage_session"
		h.preauthName = "__Host-sillage_login"
	}
	if _, err := rand.Read(h.secret); err != nil {
		return nil, err
	}
	return h, nil
}

// ServeHTTP contrôle avant les handlers, donc un 401 ne peut pas suivre une écriture métier.
func (h *AuthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
	if !strings.EqualFold(r.Host, h.host) {
		authError(w, r, 403, "invalid_host")
		return
	}
	private := r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/")
	if !private {
		h.next.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store, private")
	if r.URL.Path == "/mcp" || strings.HasPrefix(r.URL.Path, "/mcp/") {
		http.NotFound(w, r)
		return
	}
	token := cookieValue(r, h.cookieName)
	// La sonde périodique vérifie les échéances sans constituer une activité privée.
	check := h.service.Check
	if r.URL.Path == "/api/v1/auth/session" {
		check = h.service.Inspect
	}
	session, err := check(r.Context(), token)
	authenticated := err == nil
	if err != nil && !errors.Is(err, auth.ErrSession) {
		authError(w, r, 503, "authentication_unavailable")
		return
	}
	if r.URL.Path == "/api/v1/auth/session" && r.Method == http.MethodGet {
		requestlog.Route(r, "/api/v1/auth/session")
		if !authenticated {
			token = cookieValue(r, h.preauthName)
			if !h.validPreauth(token) {
				token = h.newPreauth()
				h.setCookie(w, h.preauthName, token, time.Now().Add(10*time.Minute), 600)
			}
		}
		authJSON(w, map[string]any{"authenticated": authenticated, "csrf_token": csrfToken(token), "expires_at": session.ExpiresAt})
		return
	}
	login := r.URL.Path == "/api/v1/auth/login" && r.Method == http.MethodPost
	if !authenticated && !login {
		authError(w, r, 401, "authentication_required")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		csrfSource := token
		if !authenticated {
			csrfSource = cookieValue(r, h.preauthName)
			if !h.validPreauth(csrfSource) {
				authError(w, r, 403, "csrf_invalid")
				return
			}
		}
		// L'origine configurée ne dépend jamais d'en-têtes de proxy fournis par le client.
		origins := r.Header.Values("Origin")
		if len(origins) > 1 || (len(origins) == 1 && origins[0] != h.origin) || r.Header.Get("Sec-Fetch-Site") == "cross-site" ||
			subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(csrfToken(csrfSource))) != 1 {
			authError(w, r, 403, "csrf_invalid")
			return
		}
	}
	switch {
	case login:
		h.login(w, r, token)
	case r.URL.Path == "/api/v1/auth/logout" && r.Method == http.MethodPost:
		if err := h.service.Logout(r.Context(), token); err != nil {
			authError(w, r, 503, "authentication_unavailable")
			return
		}
		h.setCookie(w, h.cookieName, "", time.Unix(1, 0), -1)
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/api/v1/auth/logout-all" && r.Method == http.MethodPost:
		if err := h.service.LogoutAll(r.Context()); err != nil {
			authError(w, r, 503, "authentication_unavailable")
			return
		}
		h.setCookie(w, h.cookieName, "", time.Unix(1, 0), -1)
		w.WriteHeader(http.StatusNoContent)
	default:
		h.next.ServeHTTP(w, r)
	}
}

// login borne le corps, la fréquence globale et la mémoire des calculs Argon2.
func (h *AuthHandler) login(w http.ResponseWriter, r *http.Request, oldToken string) {
	requestlog.Route(r, "/api/v1/auth/login")
	if !h.limiter.Allow() {
		w.Header().Set("Retry-After", "1")
		authError(w, r, 429, "login_limited")
		return
	}
	select {
	case h.hashing <- struct{}{}:
		defer func() { <-h.hashing }()
	default:
		w.Header().Set("Retry-After", "1")
		authError(w, r, 429, "login_limited")
		return
	}
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		authError(w, r, 415, "invalid_content_type")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	// Le plafond inclut les échappements JSON des identifiants acceptés par la commande locale.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil || !utf8.Valid(body) || len(bytes.TrimSpace(body)) == 0 || bytes.TrimSpace(body)[0] != '{' {
		authError(w, r, 400, "invalid_login")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		authError(w, r, 400, "invalid_login")
		return
	}
	token, err := h.service.Login(r.Context(), input.Username, input.Password)
	if errors.Is(err, auth.ErrCredentials) {
		authError(w, r, 401, "invalid_credentials")
		return
	}
	if err != nil {
		authError(w, r, 503, "authentication_unavailable")
		return
	}
	// Une nouvelle authentification remplace la session du navigateur, sans conserver un ancien cookie valide.
	if err := h.service.Logout(r.Context(), oldToken); err != nil {
		_ = h.service.Logout(r.Context(), token)
		authError(w, r, 503, "authentication_unavailable")
		return
	}
	session, err := h.service.Check(r.Context(), token)
	if err != nil {
		authError(w, r, 503, "authentication_unavailable")
		return
	}
	h.setCookie(w, h.cookieName, token, session.ExpiresAt, max(1, int(time.Until(session.ExpiresAt).Seconds())))
	h.setCookie(w, h.preauthName, "", time.Unix(1, 0), -1)
	authJSON(w, map[string]any{"authenticated": true, "csrf_token": csrfToken(token), "expires_at": session.ExpiresAt})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}
func csrfToken(token string) string { return auth.Digest("csrf:" + token) }

func (h *AuthHandler) setCookie(w http.ResponseWriter, name, value string, expires time.Time, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/",
		HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteLaxMode,
		Expires: expires, MaxAge: maxAge,
	})
}

// Les préconnexions signées sont brèves et sans stockage, pour ne pas remplir SQLite depuis une page publique.
func (h *AuthHandler) newPreauth() string {
	value := strconv.FormatInt(time.Now().Unix(), 10) + "." + rand.Text()
	return value + "." + h.sign(value)
}
func (h *AuthHandler) sign(value string) string {
	mac := hmac.New(sha256.New, h.secret)
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}
func (h *AuthHandler) validPreauth(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 200 {
		return false
	}
	stamp, err := strconv.ParseInt(parts[0], 10, 64)
	now := time.Now().Unix()
	return err == nil && stamp <= now && now-stamp < 600 && hmac.Equal([]byte(parts[2]), []byte(h.sign(parts[0]+"."+parts[1])))
}

func authJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
func authError(w http.ResponseWriter, r *http.Request, status int, code string) {
	requestlog.Result(r, code, nil)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": code}})
}
