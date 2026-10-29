package oidc

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
)

func TestProtocol(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "key"))
	if err != nil {
		t.Fatal(err)
	}
	var issuer string
	nonce := "nonce"
	subject := "owner-subject"
	var audience any = "client"
	authorizedParty := ""
	accessTokenHash := ""
	issuedAt := time.Now().Unix()
	expiration := time.Now().Add(time.Hour).Unix()
	verifier := oauth2.GenerateVerifier()
	tokenIssuer := ""
	unavailable := false
	invalidSignature := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "key", Algorithm: "RS256", Use: "sig"}}})
		case "/token":
			if r.ParseForm() != nil || r.Form.Get("code_verifier") != verifier || r.Form.Get("code") != "code" || r.Form.Get("redirect_uri") != "https://sillage.test/callback" {
				w.WriteHeader(400)
				return
			}
			iss := issuer
			if tokenIssuer != "" {
				iss = tokenIssuer
			}
			data, _ := json.Marshal(map[string]any{"iss": iss, "sub": subject, "aud": audience, "exp": expiration, "iat": issuedAt, "nonce": nonce, "azp": authorizedParty, "at_hash": accessTokenHash})
			signed, err := signer.Sign(data)
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			encoded, _ := signed.CompactSerialize()
			if invalidSignature {
				parts := strings.Split(encoded, ".")
				encoded = parts[0] + "." + parts[1] + "." + strings.Repeat("A", len(parts[2]))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "unused", "token_type": "Bearer", "id_token": encoded})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	issuer = server.URL
	provider, err := New(Config{Issuer: issuer, Subject: "owner-subject", ClientID: "client", Secret: "secret", RedirectURL: "https://sillage.test/callback"})
	if err != nil {
		t.Fatal(err)
	}
	provider.client = server.Client()
	target, err := provider.AuthorizationURL(context.Background(), "state", "nonce", verifier)
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(target)
	query := parsed.Query()
	if query.Get("response_type") != "code" || query.Get("state") != "state" || query.Get("nonce") != "nonce" || query.Get("scope") != "openid" || query.Get("code_challenge_method") != "S256" || query.Get("code_challenge") != oauth2.S256ChallengeFromVerifier(verifier) {
		t.Fatalf("invalid authorization parameters")
	}
	if err := provider.Verify(context.Background(), "code", "nonce", verifier); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"subject", "nonce", "audience", "expiration", "issuer", "verifier", "signature", "azp", "multi-audience", "at_hash", "future-issued", "outage"} {
		t.Run(scenario, func(t *testing.T) {
			candidate := verifier
			switch scenario {
			case "subject":
				subject = "other"
			case "nonce":
				nonce = "other"
			case "audience":
				audience = "other"
			case "expiration":
				expiration = time.Now().Add(-time.Hour).Unix()
			case "issuer":
				tokenIssuer = "https://other.test"
			case "verifier":
				candidate = oauth2.GenerateVerifier()
			case "azp":
				authorizedParty = "other"
			case "multi-audience":
				audience = []string{"client", "other"}
			case "at_hash":
				accessTokenHash = "incorrect"
			case "future-issued":
				issuedAt = time.Now().Add(time.Hour).Unix()
			case "signature":
				invalidSignature = true
			case "outage":
				unavailable = true
			}
			if err := provider.Verify(context.Background(), "code", "nonce", candidate); err != ErrAuthentication {
				t.Fatalf("invalid identity accepted: %v", err)
			}
			invalidSignature = false
			authorizedParty, accessTokenHash, issuedAt = "", "", time.Now().Unix()
			nonce, subject, audience, expiration, tokenIssuer, unavailable = "nonce", "owner-subject", "client", time.Now().Add(time.Hour).Unix(), "", false
		})
	}
}

func TestConfigurationAndOfflineConstruction(t *testing.T) {
	config := Config{Issuer: "https://unreachable.invalid", Subject: "subject", ClientID: "client", Secret: "private", RedirectURL: "https://sillage.test/callback"}
	if _, err := New(config); err != nil {
		t.Fatal(err)
	}
	for _, issuer := range []string{"http://provider.test", "https://user:private@provider.test", "https://provider.test?private", "https://provider.test#private"} {
		config.Issuer = issuer
		if _, err := New(config); err != ErrAuthentication || strings.Contains(err.Error(), "private") {
			t.Fatalf("invalid or unsafe error: %v", err)
		}
	}
}
