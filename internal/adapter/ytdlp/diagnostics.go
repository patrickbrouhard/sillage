package ytdlp

import (
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
)

// toolFailure conserve la cause et les seuls diagnostics autorisés des outils.
type toolFailure struct {
	cause    error
	reason   string
	exitCode int
}

func (e *toolFailure) Error() string {
	return fmt.Sprintf("external tool: reason=%s exit_code=%d", e.reason, e.exitCode)
}
func (e *toolFailure) Unwrap() error { return e.cause }

// LogValue exclut stderr, les arguments et les chemins contenus dans la cause.
func (e *toolFailure) LogValue() slog.Value {
	return slog.GroupValue(slog.String("reason", e.reason), slog.Int("exit_code", e.exitCode))
}

func toolError(err error, stderr string) error {
	code := -1
	reason := "tool_unavailable"
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code = exit.ExitCode()
		reason = toolReason(stderr)
	}
	return &toolFailure{cause: err, reason: reason, exitCode: code}
}
