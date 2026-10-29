package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// ErrAPIKey signale un identifiant d'intégration absent, expiré ou révoqué.
var ErrAPIKey = errors.New("invalid API key")

// ErrKeyInput signale des métadonnées de création invalides.
var ErrKeyInput = errors.New("invalid API key metadata")

// APIKey décrit une autorisation persistante ; son empreinte reste interne.
type APIKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Permission string     `json:"permission"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
	Hash       string     `json:"-"`
}

// APIKeyRepository garantit la création sous contrôle transactionnel de la session.
type APIKeyRepository interface {
	CreateKey(context.Context, APIKey, string, time.Duration) error
	ListKeys(context.Context) ([]APIKey, error)
	CheckKey(context.Context, string, time.Time) error
	RevokeKey(context.Context, string, time.Time) error
	RevokeKeys(context.Context, time.Time) error
	ResetAccess(context.Context, time.Time) error
}

// APIKeys gère les identifiants de lecture indépendamment des connexions Web.
type APIKeys struct {
	repository APIKeyRepository
	idle       time.Duration
}

// NewAPIKeys réutilise le délai d'inactivité des sessions administratives.
func NewAPIKeys(repository APIKeyRepository, idle time.Duration) *APIKeys {
	if idle <= 0 {
		idle = time.Hour
	}
	return &APIKeys{repository: repository, idle: idle}
}

// Create retourne le secret uniquement après validation de la transaction.
func (s *APIKeys) Create(ctx context.Context, sessionHash, name string, expires *time.Time) (APIKey, string, error) {
	now := time.Now().UTC()
	if !utf8.ValidString(name) || strings.TrimSpace(name) != name || name == "" || len(name) > 128 || strings.ContainsAny(name, "\r\n\x00") || (expires != nil && !expires.After(now)) {
		return APIKey{}, "", ErrKeyInput
	}
	secret := "sil_" + rand.Text() + rand.Text()
	key := APIKey{ID: rand.Text(), Name: name, Permission: "mcp:read", CreatedAt: now, ExpiresAt: expires, Hash: Digest(secret)}
	if err := s.repository.CreateKey(ctx, key, sessionHash, s.idle); err != nil {
		return APIKey{}, "", err
	}
	return key, secret, nil
}

// List restitue seulement les métadonnées administratives.
func (s *APIKeys) List(ctx context.Context) ([]APIKey, error) { return s.repository.ListKeys(ctx) }

// Check vérifie chaque requête sans cache positif ni prolongation d'expiration.
func (s *APIKeys) Check(ctx context.Context, secret string) error {
	if !strings.HasPrefix(secret, "sil_") || len(secret) > 128 || len(secret) < 32 {
		return ErrAPIKey
	}
	return s.repository.CheckKey(ctx, Digest(secret), time.Now().UTC())
}

// Revoke invalide une clé sans toucher aux sessions Web.
func (s *APIKeys) Revoke(ctx context.Context, id string) error {
	return s.repository.RevokeKey(ctx, id, time.Now().UTC())
}

// RevokeAll invalide les clés présentes au moment de la transaction.
func (s *APIKeys) RevokeAll(ctx context.Context) error {
	return s.repository.RevokeKeys(ctx, time.Now().UTC())
}

// ResetAccess révoque ensemble sessions et intégrations, sans modifier les identités.
func (s *APIKeys) ResetAccess(ctx context.Context) error {
	return s.repository.ResetAccess(ctx, time.Now().UTC())
}
