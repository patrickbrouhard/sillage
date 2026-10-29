package http

import (
	"context"
	"crypto/rand"
	"net/http"
	"time"

	"github.com/patrickbrouhard/sillage/internal/http/requestlog"
	"golang.org/x/oauth2"
)

// ExternalIdentity isole le protocole du gestionnaire des sessions Sillage.
type ExternalIdentity interface {
	AuthorizationURL(context.Context, string, string, string) (string, error)
	Verify(context.Context, string, string, string) error
}

type oidcFlow struct {
	previous   string
	browser    string
	nonce      string
	verifier   string
	generation int64
	expires    time.Time
	used       bool
	issued     string
}

func (h *AuthHandler) browserCookie() string {
	if h.secure {
		return "__Host-sillage_oidc"
	}
	return "sillage_oidc"
}

// oidcStart exige le CSRF habituel et lie une transaction courte au navigateur.
func (h *AuthHandler) oidcStart(w http.ResponseWriter, r *http.Request) {
	if h.oidc == nil || !h.limiter.Allow() {
		authError(w, r, 503, "oidc_unavailable")
		return
	}
	generation, err := h.service.BeginExternal(r.Context())
	if err != nil {
		authError(w, r, 403, "method_disabled")
		return
	}
	browser := cookieValue(r, h.browserCookie())
	if browser == "" || len(browser) > 128 {
		browser = rand.Text()
	}
	flow := &oidcFlow{
		browser:    browser,
		previous:   cookieValue(r, h.cookieName),
		nonce:      rand.Text(),
		verifier:   oauth2.GenerateVerifier(),
		generation: generation,
		expires:    time.Now().Add(10 * time.Minute),
	}
	state := rand.Text()
	h.flowMu.Lock()
	for key, pending := range h.flows {
		if time.Now().After(pending.expires) {
			delete(h.flows, key)
		}
	}
	if len(h.flows) >= 1024 {
		h.flowMu.Unlock()
		authError(w, r, 429, "login_limited")
		return
	}
	h.flows[state] = flow
	h.flowMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	target, err := h.oidc.AuthorizationURL(ctx, state, flow.nonce, flow.verifier)
	if err != nil {
		h.flowMu.Lock()
		delete(h.flows, state)
		h.flowMu.Unlock()
		authError(w, r, 503, "oidc_unavailable")
		return
	}
	h.setCookie(w, h.browserCookie(), browser, time.Now().Add(24*time.Hour), 86400)
	authJSON(w, map[string]string{"url": target})
}

// oidcCallback consomme state une seule fois et revérifie la transaction après l'échange réseau.
func (h *AuthHandler) oidcCallback(w http.ResponseWriter, r *http.Request) {
	requestlog.Route(r, "/api/v1/auth/oidc/callback")
	w.Header().Set("Referrer-Policy", "no-referrer")
	query := r.URL.Query()
	if len(query["state"]) != 1 || len(query["code"]) != 1 || query.Get("error") != "" || h.oidc == nil {
		authError(w, r, 400, "oidc_failed")
		return
	}
	state := query.Get("state")
	h.flowMu.Lock()
	flow := h.flows[state]
	if flow == nil || flow.used || flow.browser != cookieValue(r, h.browserCookie()) || time.Now().After(flow.expires) {
		h.flowMu.Unlock()
		authError(w, r, 400, "oidc_failed")
		return
	}
	flow.used = true
	h.flowMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	err := h.oidc.Verify(ctx, query.Get("code"), flow.nonce, flow.verifier)
	h.flowMu.Lock()
	defer h.flowMu.Unlock()
	if err != nil || h.flows[state] != flow || time.Now().After(flow.expires) {
		delete(h.flows, state)
		authError(w, r, 400, "oidc_failed")
		return
	}
	token, err := h.service.CompleteExternal(ctx, flow.generation)
	if err != nil {
		delete(h.flows, state)
		authError(w, r, 401, "oidc_failed")
		return
	}
	flow.issued = token
	if err := h.service.Logout(ctx, cookieValue(r, h.cookieName)); err != nil {
		_ = h.service.Logout(ctx, token)
		authError(w, r, 503, "authentication_unavailable")
		return
	}
	session, err := h.service.Inspect(ctx, token)
	if err != nil {
		authError(w, r, 503, "authentication_unavailable")
		return
	}
	// Conserver le lien après succès permet à une déconnexion concurrente de révoquer
	// aussi une session dont la réponse Set-Cookie serait encore en transit.
	flow.nonce, flow.verifier = "", ""
	flow.expires = session.ExpiresAt
	h.setCookie(w, h.cookieName, token, session.ExpiresAt, max(1, int(time.Until(session.ExpiresAt).Seconds())))
	h.setCookie(w, h.preauthName, "", time.Unix(1, 0), -1)
	// Le retour reste sur une destination fixe ; aucun paramètre de redirection externe n'est accepté.
	http.Redirect(w, r, "/?oidc=complete", http.StatusSeeOther)
}

// cancelFlows s'exécute sous flowMu, comme la publication du cookie de callback.
func (h *AuthHandler) cancelFlows(r *http.Request) error {
	browser := cookieValue(r, h.browserCookie())
	for key, flow := range h.flows {
		if (browser != "" && flow.browser == browser) || (flow.previous != "" && flow.previous == cookieValue(r, h.cookieName)) {
			if flow.issued != "" {
				if err := h.service.Logout(r.Context(), flow.issued); err != nil {
					return err
				}
			}
			delete(h.flows, key)
		}
	}
	return nil
}
