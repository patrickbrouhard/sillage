// Package oidc vérifie une authentification externe sans conserver les jetons du fournisseur.
package oidc

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"time"

	coreoidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ErrAuthentication masque les réponses et diagnostics potentiellement sensibles du fournisseur.
var ErrAuthentication = errors.New("OIDC authentication failed")

// Config décrit le fournisseur unique et l'identité autorisée ; Secret ne doit jamais être journalisé.
type Config struct {
	Issuer      string
	Subject     string
	ClientID    string
	Secret      string
	RedirectURL string
}

// Provider effectue la découverte à la demande : sa construction ne dépend pas du réseau.
type Provider struct {
	config Config
	client *http.Client
}

// New valide les paramètres locaux sans contacter le fournisseur.
func New(config Config) (*Provider, error) {
	issuer, err := url.Parse(config.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return nil, ErrAuthentication
	}
	redirect, err := url.Parse(config.RedirectURL)
	if err != nil || redirect.Host == "" || (redirect.Scheme != "https" && redirect.Scheme != "http") || redirect.User != nil || redirect.RawQuery != "" || redirect.Fragment != "" || config.Subject == "" || config.ClientID == "" || config.Secret == "" {
		return nil, ErrAuthentication
	}
	return &Provider{
		config: config,
		client: &http.Client{
			Timeout:       15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// discover utilise un contexte borné par l'appelant ; aucune donnée distante n'est persistée.
func (p *Provider) discover(ctx context.Context) (*coreoidc.Provider, oauth2.Config, error) {
	ctx = coreoidc.ClientContext(ctx, p.client)
	provider, err := coreoidc.NewProvider(ctx, p.config.Issuer)
	if err != nil {
		return nil, oauth2.Config{}, ErrAuthentication
	}
	endpoints := provider.Endpoint()
	// Refuser un abaissement de TLS annoncé dans les métadonnées, même si l'issuer est HTTPS.
	for _, endpoint := range []string{endpoints.AuthURL, endpoints.TokenURL} {
		u, err := url.Parse(endpoint)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
			return nil, oauth2.Config{}, ErrAuthentication
		}
	}
	var metadata struct {
		JWKS string `json:"jwks_uri"`
	}
	if provider.Claims(&metadata) != nil {
		return nil, oauth2.Config{}, ErrAuthentication
	}
	keys, err := url.Parse(metadata.JWKS)
	if err != nil || keys.Scheme != "https" || keys.Host == "" || keys.User != nil || keys.Fragment != "" {
		return nil, oauth2.Config{}, ErrAuthentication
	}
	return provider, oauth2.Config{
		ClientID:     p.config.ClientID,
		ClientSecret: p.config.Secret,
		Endpoint:     endpoints,
		RedirectURL:  p.config.RedirectURL,
		Scopes:       []string{coreoidc.ScopeOpenID},
	}, nil
}

// AuthorizationURL prépare Code + PKCE S256 ; l'appelant conserve state, nonce et verifier côté serveur.
func (p *Provider) AuthorizationURL(ctx context.Context, state, nonce, verifier string) (string, error) {
	if state == "" || nonce == "" || len(verifier) < 43 || len(verifier) > 128 {
		return "", ErrAuthentication
	}
	_, config, err := p.discover(ctx)
	if err != nil {
		return "", err
	}
	return config.AuthCodeURL(state, coreoidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), nil
}

// Verify échange le code et vérifie signature, issuer, audience, échéance, nonce et sujet exact.
// L'appelant doit auparavant consommer atomiquement une transaction liée au navigateur et vérifier state.
func (p *Provider) Verify(ctx context.Context, code, nonce, verifier string) error {
	if code == "" || nonce == "" || len(verifier) < 43 || len(verifier) > 128 {
		return ErrAuthentication
	}
	provider, config, err := p.discover(ctx)
	if err != nil {
		return err
	}
	ctx = coreoidc.ClientContext(ctx, p.client)
	token, err := config.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return ErrAuthentication
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		return ErrAuthentication
	}
	identity, err := provider.Verifier(&coreoidc.Config{ClientID: p.config.ClientID}).Verify(ctx, raw)
	if err != nil {
		return ErrAuthentication
	}
	if identity.AccessTokenHash != "" && identity.VerifyAccessToken(token.AccessToken) != nil {
		return ErrAuthentication
	}
	if identity.IssuedAt.IsZero() || identity.IssuedAt.After(time.Now().Add(time.Minute)) {
		return ErrAuthentication
	}
	if identity.Issuer != p.config.Issuer || identity.Subject != p.config.Subject || subtle.ConstantTimeCompare([]byte(identity.Nonce), []byte(nonce)) != 1 {
		return ErrAuthentication
	}
	// azp identifie le client autorisé lorsque le jeton porte plusieurs audiences.
	var claims struct {
		AuthorizedParty string `json:"azp"`
	}
	if identity.Claims(&claims) != nil || (claims.AuthorizedParty != "" && claims.AuthorizedParty != p.config.ClientID) || (len(identity.Audience) > 1 && claims.AuthorizedParty != p.config.ClientID) {
		return ErrAuthentication
	}
	return nil
}
