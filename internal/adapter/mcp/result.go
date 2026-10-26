package mcp

import (
	"context"
	"encoding/json"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/patrickbrouhard/sillage/internal/logging"
)

// serverImplementation est l'identité fixe partagée avec le SDK et ses métadonnées finales.
var serverImplementation = &sdk.Implementation{Name: "sillage", Version: "0.1.0"}

// toolResults intervient après callTool : le SDK a déjà fixé resultType pour 2026.
// L'identité est posée via Meta avant mesure ; annotateServerInfo du SDK la conserve.
// Les tests HTTP vérifient les octets finaux afin de détecter toute évolution de ce point d'extension.
func (h *Handler) toolResults(next sdk.MethodHandler) sdk.MethodHandler {
	return func(ctx context.Context, method string, request sdk.Request) (sdk.Result, error) {
		req, ok := request.(*sdk.CallToolRequest)
		if method != "tools/call" || !ok || !knownTool(req.Params.Name) {
			return next(ctx, method, request)
		}
		started := time.Now()
		code := "internal_error"
		defer func() {
			logging.From(ctx).InfoContext(ctx, "MCP tool completed",
				"event", "mcp.tool_completed", "tool", req.Params.Name,
				"result_code", code, "elapsed_ms", time.Since(started).Milliseconds())
		}()
		select {
		case h.calls <- struct{}{}:
			defer func() { <-h.calls }()
		default:
			code = "busy"
			return failure(code, "Four local reads are already running; retry later."), nil
		}
		ctx, cancel := context.WithTimeout(ctx, h.timeout)
		defer cancel()
		stop := context.AfterFunc(h.ctx, cancel)
		defer stop()
		// Les valeurs traversent le détachement historique ; l'annulation reste explicitement liée au POST.
		if requestCtx, ok := ctx.Value(requestContextKey{}).(context.Context); ok {
			stopRequest := context.AfterFunc(requestCtx, cancel)
			defer stopRequest()
		}
		result, err := next(ctx, method, request)
		if err != nil {
			return result, err
		}
		res, ok := result.(*sdk.CallToolResult)
		if !ok || res == nil {
			return failure("internal_error", "Local read failed."), nil
		}
		if ctx.Err() != nil {
			c, message := publicError(ctx.Err())
			replaceResult(res, failure(c, message))
		}
		if req.ProtocolVersion() == "2026-07-28" {
			res.Meta = sdk.Meta{sdk.MetaKeyServerInfo: serverImplementation}
		}
		data, err := json.Marshal(res)
		if err != nil {
			replaceResult(res, failure("internal_error", "Local read failed."))
		} else if len(data) > h.responseBytes {
			// Cette mesure inclut resultType et _meta ; l'enveloppe JSON-RPC reste hors du plafond d'outil.
			replaceResult(res, tooLarge(h.responseBytes, len(data), false))
		}
		if ctx.Err() != nil {
			c, message := publicError(ctx.Err())
			replaceResult(res, failure(c, message))
		}
		code = resultCode(res)
		return res, nil
	}
}

// replaceResult conserve les champs protocolaires déjà fixés par le SDK.
func replaceResult(result, replacement *sdk.CallToolResult) {
	result.Content = replacement.Content
	result.StructuredContent = replacement.StructuredContent
	result.IsError = replacement.IsError
}

// resultCode ne lit que l'enveloppe d'erreur locale, jamais les arguments ni les contenus de succès.
func resultCode(result *sdk.CallToolResult) string {
	if !result.IsError {
		return "ok"
	}
	raw, ok := result.StructuredContent.(json.RawMessage)
	if !ok {
		return "internal_error"
	}
	var envelope struct{ Error errorDTO }
	if json.Unmarshal(raw, &envelope) != nil {
		return "internal_error"
	}
	switch envelope.Error.Code {
	case "invalid_arguments", "video_not_found", "source_not_found", "note_not_found",
		"transcript_not_found", "transcript_read_failed", "response_too_large",
		"deadline_exceeded", "canceled", "busy", "internal_error":
		return envelope.Error.Code
	default:
		return "internal_error"
	}
}

func knownTool(name string) bool {
	switch name {
	case "search_videos", "get_video", "get_transcript", "get_note":
		return true
	}
	return false
}
