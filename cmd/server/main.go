// Command server expose la bibliothèque Sillage via HTTP.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// databasePath est relatif au répertoire de travail, également dans le conteneur.
const databasePath = "data/sillage.db"

type config struct {
	addr        string
	postTimeout time.Duration
}

func loadConfig() (config, error) {
	cfg := config{addr: "127.0.0.1:8080", postTimeout: 60 * time.Second}
	if v, ok := os.LookupEnv("SILLAGE_HTTP_ADDR"); ok {
		cfg.addr = v
	}
	if v, ok := os.LookupEnv("SILLAGE_POST_TIMEOUT"); ok {
		duration, err := time.ParseDuration(v)
		if err != nil || duration <= 0 {
			return config{}, fmt.Errorf("SILLAGE_POST_TIMEOUT must be a positive duration")
		}
		cfg.postTimeout = duration
	}
	if _, _, err := net.SplitHostPort(cfg.addr); err != nil {
		return config{}, fmt.Errorf("invalid SILLAGE_HTTP_ADDR: %w", err)
	}
	return cfg, nil
}

func main() {
	if err := runMain(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runMain() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return run(ctx, cfg)
}

// newHTTPServer borne les lectures sans couper la réponse du timeout applicatif.
// WriteTimeout reste désactivé : le contexte du POST borne le traitement,
// y compris lorsque son délai configurable dépasse une minute.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr: addr, Handler: handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
		WriteTimeout:      0,
	}
}

// run crée le dossier de données fixe ; aucune ancienne base n'est déplacée.
func run(ctx context.Context, cfg config) error {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		return fmt.Errorf("create database directory: %w", err)
	}
	db, err := sqlite.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	service := video.NewService(sqlite.NewVideoRepository(db), ytdlp.Client{})
	server := newHTTPServer(cfg.addr, api.NewRouter(service, cfg.postTimeout))
	server.BaseContext = func(net.Listener) context.Context { return ctx }
	listener, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			server.Close()
			<-done
			return fmt.Errorf("shutdown HTTP server: %w", err)
		}
		<-done
		return nil
	}
}
