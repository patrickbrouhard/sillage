// Package logging configure slog et transporte son contexte sans dépendance HTTP.
package logging

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"syscall"
)

type contextKey struct{}
type requestKey struct{}

var silent = slog.New(slog.NewTextHandler(io.Discard, nil))

// New construit un logger standard ; seules les quatre sévérités convenues sont admises.
func New(output io.Writer, level, format string) (*slog.Logger, error) {
	var minimum slog.Level
	switch level {
	case "DEBUG":
		minimum = slog.LevelDebug
	case "INFO":
		minimum = slog.LevelInfo
	case "WARN":
		minimum = slog.LevelWarn
	case "ERROR":
		minimum = slog.LevelError
	default:
		return nil, fmt.Errorf("SILLAGE_LOG_LEVEL must be DEBUG, INFO, WARN or ERROR")
	}
	options := &slog.HandlerOptions{Level: minimum}
	switch format {
	case "text":
		return slog.New(slog.NewTextHandler(output, options)), nil
	case "json":
		return slog.New(slog.NewJSONHandler(output, options)), nil
	default:
		return nil, fmt.Errorf("SILLAGE_LOG_FORMAT must be text or json")
	}
}

// WithLogger associe un logger au contexte sans changer son annulation.
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, contextKey{}, logger)
}

// From retourne un logger silencieux lorsque l'appelant n'en a pas fourni.
func From(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(contextKey{}).(*slog.Logger); ok && logger != nil {
		return logger
	}
	return silent
}

// WithRequest associe l'identité HTTP générée, indépendamment d'une clé de commande.
func WithRequest(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestKey{}, id)
}

// RequestID fournit l'identité HTTP uniquement à la frontière d'acceptation.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestKey{}).(string)
	return id
}

// Error ne sérialise jamais le texte arbitraire d'une erreur.
// Les adapters peuvent fournir une représentation slog explicitement sûre.
func Error(err error) slog.Attr {
	var safe slog.LogValuer
	if errors.As(err, &safe) {
		return slog.Any("error", safe)
	}
	reason := "internal_error"
	switch {
	case errors.Is(err, context.Canceled):
		reason = "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		reason = "timeout"
	case errors.Is(err, os.ErrNotExist):
		reason = "not_found"
	case errors.Is(err, os.ErrPermission):
		reason = "permission_denied"
	case errors.Is(err, syscall.ENOSPC):
		reason = "no_space"
	case errors.Is(err, syscall.EIO):
		reason = "io_error"
	}
	return slog.Group("error", slog.String("reason", reason))
}
