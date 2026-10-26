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
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/patrickbrouhard/sillage/internal/adapter/filesystem"
	mcpadapter "github.com/patrickbrouhard/sillage/internal/adapter/mcp"
	"github.com/patrickbrouhard/sillage/internal/adapter/sqlite"
	"github.com/patrickbrouhard/sillage/internal/adapter/ytdlp"
	"github.com/patrickbrouhard/sillage/internal/asset"
	api "github.com/patrickbrouhard/sillage/internal/http"
	"github.com/patrickbrouhard/sillage/internal/logging"
	"github.com/patrickbrouhard/sillage/internal/media"
	"github.com/patrickbrouhard/sillage/internal/note"
	"github.com/patrickbrouhard/sillage/internal/search"
	"github.com/patrickbrouhard/sillage/internal/transcript"
	"github.com/patrickbrouhard/sillage/internal/video"
)

// databasePath est relatif au répertoire de travail, également dans le conteneur.
const databasePath = "data/sillage.db"

type config struct {
	mcpEnabled      bool
	mcpAuthorities  []string
	addr            string
	postTimeout     time.Duration
	downloadTimeout time.Duration
	webDir          string
	logLevel        string
	logFormat       string
}

func loadConfig() (config, error) {
	cfg := config{addr: "127.0.0.1:8080", postTimeout: 60 * time.Second, downloadTimeout: 6 * time.Hour}
	cfg.logLevel, cfg.logFormat = "INFO", "text"
	if value, ok := os.LookupEnv("SILLAGE_LOG_LEVEL"); ok {
		cfg.logLevel = value
	}
	if value, ok := os.LookupEnv("SILLAGE_LOG_FORMAT"); ok {
		cfg.logFormat = value
	}
	if _, err := logging.New(os.Stdout, cfg.logLevel, cfg.logFormat); err != nil {
		return config{}, err
	}
	cfg.webDir = os.Getenv("SILLAGE_WEB_DIR")
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
	if value, ok := os.LookupEnv("SILLAGE_DOWNLOAD_TIMEOUT"); ok {
		duration, err := time.ParseDuration(value)
		if err != nil || duration <= 0 {
			return config{}, fmt.Errorf("SILLAGE_DOWNLOAD_TIMEOUT must be a positive duration")
		}
		cfg.downloadTimeout = duration
	}
	if _, _, err := net.SplitHostPort(cfg.addr); err != nil {
		return config{}, fmt.Errorf("invalid SILLAGE_HTTP_ADDR")
	}
	if value, ok := os.LookupEnv("SILLAGE_MCP_ENABLED"); ok {
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return config{}, fmt.Errorf("SILLAGE_MCP_ENABLED must be a boolean")
		}
		cfg.mcpEnabled = enabled
	}
	_, port, _ := net.SplitHostPort(cfg.addr)
	cfg.mcpAuthorities = []string{
		net.JoinHostPort("127.0.0.1", port),
		net.JoinHostPort("localhost", port),
		net.JoinHostPort("::1", port),
	}
	if value, ok := os.LookupEnv("SILLAGE_MCP_ALLOWED_AUTHORITIES"); ok {
		cfg.mcpAuthorities = strings.Split(value, ",")
	}
	if cfg.mcpEnabled {
		if err := mcpadapter.ValidateAuthorities(cfg.mcpAuthorities); err != nil {
			return config{}, err
		}
	}
	return cfg, nil
}

func main() {
	if err := runMain(); err != nil {
		os.Exit(1)
	}
}

func runMain() error {
	cfg, err := loadConfig()
	if err != nil {
		// Le format de secours est déterministe si la configuration est invalide.
		logger, _ := logging.New(os.Stdout, "INFO", "json")
		logger.Error("Server configuration failed", "event", "server.configuration_failed", "reason", err.Error())
		return err
	}
	logger, _ := logging.New(os.Stdout, cfg.logLevel, cfg.logFormat)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return run(logging.WithLogger(ctx, logger), cfg)
}

// newHTTPServer borne les lectures sans couper la réponse du timeout applicatif.
// WriteTimeout reste désactivé : le contexte du POST borne le traitement,
// y compris lorsque son délai configurable dépasse une minute.
// MCP fixe ses propres délais de lecture et d’envoi dans son adapter.
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
func run(ctx context.Context, cfg config) (result error) {
	logger := logging.From(ctx).With("component", "server")
	phase := "database"
	logger.InfoContext(ctx, "Server starting", "event", "server.starting")
	defer func() {
		if result != nil {
			logger.ErrorContext(ctx, "Server failed", "event", "server.failed", "stage", phase, logging.Error(result))
		} else {
			logger.InfoContext(ctx, "Server stopped", "event", "server.stopped")
		}
	}()

	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		return fmt.Errorf("create database directory: %w", err)
	}
	db, err := sqlite.Open(ctx, databasePath)
	if err != nil {
		return err
	}
	defer db.Close()
	videos := sqlite.NewVideoRepository(db)
	provider := ytdlp.Client{}
	service := video.NewService(videos, provider)
	transcripts := transcript.NewService(
		videos,
		sqlite.NewTranscriptRepository(db),
		provider,
		filesystem.NewTranscripts("data/transcripts", ytdlp.ParseJSON3),
	)
	phase = "media_recovery"
	downloads, err := media.NewService(
		ctx, videos, sqlite.NewMediaRepository(db), filesystem.NewMedia("data/media"),
		ytdlp.MediaClient{}, cfg.downloadTimeout,
	)
	if err != nil {
		return fmt.Errorf("initialize media: %w", err)
	}
	defer downloads.Close()
	phase = "capture_recovery"
	captures, err := asset.NewService(ctx, videos, sqlite.NewAssetRepository(db), downloads, ytdlp.CaptureClient{}, filesystem.NewAssets("data/assets"), 2*time.Minute)
	if err != nil {
		return fmt.Errorf("initialize captures: %w", err)
	}
	defer captures.Close()
	notes := note.NewService(sqlite.NewNoteRepository(db))
	searches := search.NewService(sqlite.NewSearchRepository(db))
	var handler http.Handler = api.NewRouter(
		downloads,
		video.NewPublisherService(sqlite.NewPublisherRepository(db), provider),
		video.NewPersonService(sqlite.NewPersonRepository(db)),
		notes,
		video.NewTagService(sqlite.NewTagRepository(db)),
		transcripts,
		service,
		cfg.postTimeout,
		captures,
	)
	handler = api.WithSearch(handler, searches)
	var mcpTransport http.Handler
	if cfg.mcpEnabled {
		phase = "mcp"
		endpoint, err := mcpadapter.New(ctx, mcpadapter.Readers{
			Search:      searches,
			Videos:      service,
			Transcripts: transcripts,
			Notes:       notes,
		}, cfg.mcpAuthorities)
		if err != nil {
			return err
		}
		defer endpoint.Close()
		mcpTransport = endpoint
	}
	handler = api.WithMCP(handler, mcpTransport)
	// Le build est facultatif pour garder le lancement API seul indépendant de Node.
	phase = "frontend"
	if cfg.webDir != "" {
		root, err := os.OpenRoot(cfg.webDir)
		if err != nil {
			return fmt.Errorf("open frontend directory: %w", err)
		}
		defer root.Close()
		handler, err = api.NewWebHandler(handler, root.FS())
		if err != nil {
			return err
		}
	}
	server := newHTTPServer(cfg.addr, api.WithLogging(logging.From(ctx), handler))
	server.ErrorLog = api.ServerErrorLog(logger)
	server.BaseContext = func(net.Listener) context.Context { return ctx }
	phase = "listen"
	listener, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	phase = "serve"
	logger.InfoContext(ctx, "Server ready", "event", "server.ready")
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		phase = "shutdown"
		logger.InfoContext(ctx, "Server stopping", "event", "server.stopping")
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
