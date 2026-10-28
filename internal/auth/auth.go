// Package auth gère l'identité unique et les sessions indépendamment du transport.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// Erreurs publiques indépendantes du transport.
var (
	ErrCredentials   = errors.New("invalid credentials")
	ErrSession       = errors.New("invalid session")
	ErrUninitialized = errors.New("owner not initialized; run sillage owner init")
	ErrExists        = errors.New("owner already initialized")
	ErrPassword      = errors.New("password must contain at least 15 characters and at most 1024 bytes")
	ErrUsername      = errors.New("username must contain 1 to 128 bytes without surrounding whitespace")
)

// Owner représente l'identité ; Version invalide les connexions concurrentes à une récupération.
type Owner struct {
	Username     string
	PasswordHash string
	Version      int64
}

// Session conserve uniquement l'empreinte du cookie.
type Session struct {
	Hash       string
	Version    int64
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastSeenAt time.Time
}

// Repository garantit l'unicité et la révocation atomique.
type Repository interface {
	Owner(context.Context) (Owner, error)
	CreateOwner(context.Context, Owner) error
	RecoverOwner(context.Context, string) error
	CreateSession(context.Context, Session) error
	Session(context.Context, string, time.Time, time.Duration, bool) (Session, error)
	Revoke(context.Context, string) error
	RevokeAll(context.Context) error
}

// Service partage le cycle des sessions entre méthodes d'authentification.
type Service struct {
	repository Repository
	lifetime   time.Duration
	idle       time.Duration
	now        func() time.Time
}

// NewService fixe douze heures de durée absolue et une heure d'inactivité par défaut.
func NewService(repository Repository, lifetime, idle time.Duration) *Service {
	if lifetime <= 0 {
		lifetime = 12 * time.Hour
	}
	if idle <= 0 {
		idle = time.Hour
	}
	return &Service{repository: repository, lifetime: lifetime, idle: idle, now: time.Now}
}

// Initialize crée le propriétaire sans remplacer un compte existant.
func (s *Service) Initialize(ctx context.Context, username, password string) error {
	if username == "" || len(username) > 128 || username != strings.TrimSpace(username) || strings.ContainsAny(username, "\r\n\x00") {
		return ErrUsername
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return s.repository.CreateOwner(ctx, Owner{Username: username, PasswordHash: hash, Version: 1})
}

// Recover remplace le secret et révoque toutes les sessions atomiquement.
func (s *Service) Recover(ctx context.Context, password string) error {
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return s.repository.RecoverOwner(ctx, hash)
}

// Ready refuse un serveur dépourvu de propriétaire.
func (s *Service) Ready(ctx context.Context) error { _, err := s.repository.Owner(ctx); return err }

// Login vérifie le secret avant d'émettre une session indépendante de la connexion locale.
func (s *Service) Login(ctx context.Context, username, password string) (string, error) {
	owner, err := s.repository.Owner(ctx)
	if err != nil {
		return "", err
	}
	// Le calcul reste identique lorsque seul l'identifiant est erroné.
	valid := VerifyPassword(owner.PasswordHash, password)
	if !valid || username != owner.Username {
		return "", ErrCredentials
	}
	return s.issue(ctx, owner.Version)
}

func (s *Service) issue(ctx context.Context, version int64) (string, error) {
	token := rand.Text()
	now := s.now().UTC()
	err := s.repository.CreateSession(ctx, Session{
		Hash:       Digest(token),
		Version:    version,
		CreatedAt:  now,
		ExpiresAt:  now.Add(s.lifetime),
		LastSeenAt: now,
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// Digest calcule une empreinte à sens unique d'un jeton aléatoire.
func Digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Check vérifie la révocation et les expirations avant chaque nouvelle requête.
func (s *Service) Check(ctx context.Context, token string) (Session, error) {
	return s.check(ctx, token, true)
}

// Inspect vérifie la session sans prolonger son activité, notamment pour les sondes du navigateur.
func (s *Service) Inspect(ctx context.Context, token string) (Session, error) {
	return s.check(ctx, token, false)
}

func (s *Service) check(ctx context.Context, token string, touch bool) (Session, error) {
	if token == "" || len(token) > 128 {
		return Session{}, ErrSession
	}
	return s.repository.Session(ctx, Digest(token), s.now().UTC(), s.idle, touch)
}

// Logout révoque seulement la session demandée.
func (s *Service) Logout(ctx context.Context, token string) error {
	return s.repository.Revoke(ctx, Digest(token))
}

// LogoutAll invalide aussi les connexions commencées avant la révocation.
func (s *Service) LogoutAll(ctx context.Context) error { return s.repository.RevokeAll(ctx) }
