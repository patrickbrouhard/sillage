package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"testing"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/auth"
)

// initializeTestOwner prépare la même identité que la commande interactive.
func initializeTestOwner(t *testing.T) {
	t.Helper()
	if err := os.MkdirAll("data", 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sqlite.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := auth.NewService(sqlite.NewAuthRepository(db), 0, 0)
	values := []string{"owner", "a sufficiently long password", "a sufficiently long password"}
	err = administerOwner(context.Background(), service, "init", func(_ string, _ bool) (string, error) { s := values[0]; values = values[1:]; return s, nil }, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
}

type csrfTransport struct {
	base  http.RoundTripper
	token string
}

func (c csrfTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("X-CSRF-Token", c.token)
	return c.base.RoundTrip(r)
}

func loginTestClient(t *testing.T, client *http.Client, base string) {
	t.Helper()
	client.Jar, _ = cookiejar.New(nil)
	response, err := client.Get(base + "/auth/session")
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = csrfTransport{transport, state.CSRF}
	response, err = client.Post(base+"/auth/login", "application/json", strings.NewReader(`{"username":"owner","password":"a sufficiently long password"}`))
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	client.Transport = csrfTransport{transport, state.CSRF}
}

func TestRecoveryCommand(t *testing.T) {
	t.Chdir(t.TempDir())
	initializeTestOwner(t)
	db, err := sqlite.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	service := auth.NewService(sqlite.NewAuthRepository(db), 0, 0)
	token, err := service.Login(context.Background(), "owner", "a sufficiently long password")
	if err != nil {
		t.Fatal(err)
	}
	err = administerOwner(context.Background(), service, "recover", func(_ string, _ bool) (string, error) { return "replacement password phrase", nil }, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Check(context.Background(), token); err != auth.ErrSession {
		t.Fatal(err)
	}
	if _, err := service.Login(context.Background(), "owner", "replacement password phrase"); err != nil {
		t.Fatal(err)
	}
}

func TestSessionConfig(t *testing.T) {
	clearConfig(t)
	t.Setenv("SILLAGE_SESSION_LIFETIME", "2h")
	t.Setenv("SILLAGE_SESSION_IDLE_TIMEOUT", "30m")
	if _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"0", "30s", "-1h", "1000h", "oops"} {
		t.Setenv("SILLAGE_SESSION_IDLE_TIMEOUT", v)
		if _, err := loadConfig(); err == nil {
			t.Fatal(v)
		}
	}
}
