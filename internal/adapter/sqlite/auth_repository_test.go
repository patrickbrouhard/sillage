package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/patrickbrouhard/sillage/internal/auth"
)

func TestOwnerSessionPersistenceAndRecovery(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "sillage.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	repo := NewAuthRepository(db)
	service := auth.NewService(repo, time.Hour, 20*time.Minute)
	if !errors.Is(service.Ready(ctx), auth.ErrUninitialized) {
		t.Fatal("missing owner accepted")
	}
	const password = "une longue phrase secrète"
	if err := service.Initialize(ctx, "patrick", password); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(service.Initialize(ctx, "other", password), auth.ErrExists) {
		t.Fatal("owner replaced")
	}
	for _, pair := range [][2]string{{"other", password}, {"patrick", "incorrect password"}} {
		if _, err := service.Login(ctx, pair[0], pair[1]); !errors.Is(err, auth.ErrCredentials) {
			t.Fatal(err)
		}
	}
	token, err := service.Login(ctx, "patrick", password)
	if err != nil {
		t.Fatal(err)
	}
	session, err := service.Check(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := db.QueryRow("SELECT token_hash FROM web_sessions").Scan(&stored); err != nil || stored == token {
		t.Fatal("raw token stored", err)
	}
	db.Close()
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo = NewAuthRepository(db)
	service = auth.NewService(repo, time.Hour, 20*time.Minute)
	if _, err := service.Check(ctx, token); err != nil {
		t.Fatal("restart lost session", err)
	}
	if err := service.Recover(ctx, "une autre phrase secrète"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal("recovery kept session", err)
	}
	// Une connexion ayant déjà vérifié l'ancien secret ne doit pas survivre à la récupération.
	session.Hash = "late-session"
	if err := repo.CreateSession(ctx, session); !errors.Is(err, auth.ErrCredentials) {
		t.Fatal("stale generation accepted", err)
	}
	token, err = service.Login(ctx, "patrick", "une autre phrase secrète")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Logout(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(ctx, token); !errors.Is(err, auth.ErrSession) {
		t.Fatal(err)
	}
}

func TestSessionDeadlinesAndRevocation(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "sillage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewAuthRepository(db)
	if err := repo.CreateOwner(ctx, auth.Owner{Username: "owner", PasswordHash: "unused"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	for _, test := range []struct {
		name          string
		expires, seen time.Time
		valid         bool
	}{
		{"valid", now.Add(time.Hour), now.Add(-time.Minute), true},
		{"expired", now, now, false},
		{"old-activity", now.Add(time.Hour), now.Add(-time.Hour), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := auth.Session{Hash: test.name, Version: 1, CreatedAt: now.Add(-time.Hour), ExpiresAt: test.expires, LastSeenAt: test.seen}
			if err := repo.CreateSession(ctx, s); err != nil {
				t.Fatal(err)
			}
			_, err := repo.Session(ctx, s.Hash, now, 30*24*time.Hour, 24*time.Hour, true)
			if (err == nil) != test.valid {
				t.Fatal(err)
			}
		})
	}
	if err := repo.RevokeAll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Session(ctx, "valid", now, 30*24*time.Hour, 24*time.Hour, true); !errors.Is(err, auth.ErrSession) {
		t.Fatal(err)
	}
}

func TestSlidingSessionRenewal(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "sliding.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewAuthRepository(db)
	if err := repo.CreateOwner(ctx, auth.Owner{Username: "owner", PasswordHash: "unused"}); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Truncate(time.Millisecond)
	lifetime, interval := 30*24*time.Hour, 24*time.Hour
	initial := auth.Session{Hash: "token", Version: 1, CreatedAt: start, LastSeenAt: start, ExpiresAt: start.Add(lifetime)}
	if err := repo.CreateSession(ctx, initial); err != nil {
		t.Fatal(err)
	}
	check := func(at time.Time, touch bool, expires time.Time) auth.Session {
		t.Helper()
		session, err := repo.Session(ctx, initial.Hash, at, lifetime, interval, touch)
		if err != nil {
			t.Fatal(err)
		}
		if !session.ExpiresAt.Equal(expires) || !session.CreatedAt.Equal(start) {
			t.Fatal("unexpected renewal", session)
		}
		return session
	}
	check(start.Add(interval-time.Millisecond), true, initial.ExpiresAt)
	check(start.Add(interval), false, initial.ExpiresAt)
	renewed := check(start.Add(interval), true, start.Add(interval+lifetime))
	if !renewed.LastSeenAt.Equal(start.Add(interval)) {
		t.Fatal("renewal date not persisted")
	}
	check(start.Add(interval+time.Hour), true, renewed.ExpiresAt)
	// Une utilisation régulière dépasse la date de création de plus de trente jours.
	for day := 2; day <= 60; day++ {
		now := start.Add(time.Duration(day) * interval)
		renewed = check(now, true, now.Add(lifetime))
	}
	for _, touch := range []bool{false, true} {
		if _, err := repo.Session(ctx, initial.Hash, renewed.ExpiresAt, lifetime, interval, touch); !errors.Is(err, auth.ErrSession) {
			t.Fatal("expired session revived", err)
		}
	}
	if err := repo.RevokeAll(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Session(ctx, initial.Hash, start.Add(61*interval), lifetime, interval, true); !errors.Is(err, auth.ErrSession) {
		t.Fatal("revoked session revived", err)
	}
}

func TestConcurrentRenewalAndRevocation(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "renew-race.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := NewAuthRepository(db)
	if err := repo.CreateOwner(ctx, auth.Owner{Username: "owner", PasswordHash: "unused"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	for i := 0; i < 10; i++ {
		owner, err := repo.Owner(ctx)
		if err != nil {
			t.Fatal(err)
		}
		session := auth.Session{Hash: "token", Version: owner.Version, CreatedAt: now.Add(-48 * time.Hour), LastSeenAt: now.Add(-48 * time.Hour), ExpiresAt: now.Add(time.Hour)}
		if err := repo.CreateSession(ctx, session); err != nil {
			t.Fatal(err)
		}
		start, done := make(chan struct{}), make(chan error, 3)
		for range 2 {
			go func() {
				<-start
				_, err := repo.Session(ctx, "token", now, 30*24*time.Hour, 24*time.Hour, true)
				if errors.Is(err, auth.ErrSession) {
					err = nil
				}
				done <- err
			}()
		}
		go func() { <-start; done <- repo.RevokeAll(ctx) }()
		close(start)
		for range 3 {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		if _, err := repo.Session(ctx, "token", now, 30*24*time.Hour, 24*time.Hour, true); !errors.Is(err, auth.ErrSession) {
			t.Fatal("revoked session revived", err)
		}
	}
}
