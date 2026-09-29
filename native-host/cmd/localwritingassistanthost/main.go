// Command localwritingassistanthost is the native messaging host that
// bridges the Chrome extension to the local LM Studio server.
//
// Wire protocol: Chrome Native Messaging (length-prefixed JSON over
// stdin/stdout). All non-message output MUST go to stderr.
//
// Security model (section 34):
//   - The host is a security boundary. Only known commands are accepted.
//   - The host dials LM Studio on 127.0.0.1 / localhost only.
//   - The host exposes NO command that executes shell, PowerShell, cmd,
//     bash, or eval. It cannot be turned into a general-purpose runner.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"localwritingassistant.host/internal/lmstudio"
	"localwritingassistant.host/internal/logging"
	"localwritingassistant.host/internal/mock"
	"localwritingassistant.host/internal/protocol"
	"localwritingassistant.host/internal/security"
)

// HostConfig is a small on-disk config the installer may drop next to
// the executable to override defaults. We don't require it.
type HostConfig struct {
	BaseURL string `json:"baseUrl,omitempty"`
	Token   string `json:"token,omitempty"`
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil && !errors.Is(err, io.EOF) {
		logging.Error("HOST_FATAL", err.Error())
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	// Read config from %LOCALAPPDATA%\LocalWritingAssistant\host-config.json
	// if present; otherwise default to http://127.0.0.1:1234.
	cfg := loadConfig()
	for {
		req, err := protocol.ReadRequest(in)
		if err != nil {
			if errors.Is(err, io.EOF) {
				// Clean stdin close — Chrome shut down the host.
				return nil
			}
			logging.Error("READ_FAILED", err.Error())
			// Any other read error means the stream is desynchronized
			// (e.g. io.ErrUnexpectedEOF from a truncated message body).
			// We CANNOT safely continue — the next binary.Read would
			// treat body bytes as a length prefix, leading to hangs or
			// wrong-payload confusion. Exit and let Chrome respawn us.
			return err
		}
		handleRequest(req, cfg, out)
	}
}

func handleRequest(req *protocol.Request, cfg HostConfig, out io.Writer) {
	rid := req.RequestID
	if !security.IsAllowedCommand(req.Command) {
		writeErr(out, rid, "UNKNOWN_COMMAND", fmt.Sprintf("unknown command: %q", req.Command))
		return
	}
	logging.Info("REQUEST_STARTED", fmt.Sprintf("cmd=%s rid=%s mock=%v", req.Command, rid, mock.Enabled()))
	switch req.Command {
	case "ping":
		writeOK(out, rid, map[string]any{"ok": true, "version": hostVersion(), "mock": mock.Enabled()})
	case "get_config":
		writeOK(out, rid, map[string]any{
			"baseUrl": cfg.BaseURL,
			"version": hostVersion(),
			"mock":    mock.Enabled(),
		})
	case "get_models":
		if mock.Enabled() {
			// Return the SAME shape as the real get_models handler
			// ({models: [{id, ...}]}) so the extension's parsing
			// code in service-worker.ts handleGetModels works
			// identically in mock and real modes. Previously the
			// mock returned {raw: "...", mock: true} which the
			// extension read as 'no models'.
			var data any
			_ = json.Unmarshal([]byte(mock.ModelsResponse()), &data)
			if m, ok := data.(map[string]any); ok {
				m["mock"] = true
				writeOK(out, rid, m)
			} else {
				writeOK(out, rid, map[string]any{"models": []any{}, "mock": true})
			}
			return
		}
		handleGetModels(req, rid, cfg, out)
	case "check_connection":
		if mock.Enabled() {
			// Parse the mock JSON and pass through as data.
			var data any
			_ = json.Unmarshal([]byte(mock.CheckConnectionResponse()), &data)
			writeOK(out, rid, data)
			return
		}
		handleCheckConnection(req, rid, cfg, out)
	case "grammar_check":
		if mock.Enabled() {
			handleGrammarCheckMock(req, rid, out)
			return
		}
		handleGrammarCheck(req, rid, cfg, out)
	case "rewrite":
		if mock.Enabled() {
			handleRewriteMock(req, rid, out)
			return
		}
		handleRewrite(req, rid, cfg, out)
	default:
		writeErr(out, rid, "UNKNOWN_COMMAND", req.Command)
	}
}

func handleGetModels(req *protocol.Request, rid string, cfg HostConfig, out io.Writer) {
	client, err := lmstudio.New(cfg.BaseURL, cfg.Token)
	if err != nil {
		writeErr(out, rid, "INSTALLATION_ERROR", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	models, err := client.ListModels(ctx)
	if err != nil {
		writeErr(out, rid, "LM_STUDIO_OFFLINE", err.Error())
		return
	}
	if len(models) == 0 {
		writeErr(out, rid, "LM_STUDIO_NO_MODEL", "no model loaded")
		return
	}
	writeOK(out, rid, map[string]any{"models": models})
}

func handleCheckConnection(req *protocol.Request, rid string, cfg HostConfig, out io.Writer) {
	var payload struct {
		Lightweight bool `json:"lightweight"`
	}
	if len(req.Payload) > 0 {
		_ = json.Unmarshal(req.Payload, &payload)
	}
	// We always do the full check; the lightweight flag is informational only.
	result := map[string]any{
		"nativeHost":        true,
		"lmStudioReachable": false,
		"modelsEndpointOk":  false,
		"atLeastOneModel":   false,
		"testRequestOk":     false,
		"models":            []any{},
		"message":           "",
	}
	client, err := lmstudio.New(cfg.BaseURL, cfg.Token)
	if err != nil {
		result["message"] = fmt.Sprintf("configuration error: %v", err)
		writeOK(out, rid, result)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	models, err := client.ListModels(ctx)
	if err != nil {
		result["message"] = fmt.Sprintf("LM Studio unreachable: %v", err)
		writeOK(out, rid, result)
		return
	}
	result["lmStudioReachable"] = true
	result["modelsEndpointOk"] = true
	if len(models) > 0 {
		result["atLeastOneModel"] = true
		modelList := make([]any, 0, len(models))
		for _, m := range models {
			modelList = append(modelList, map[string]any{
				"id": m.ID,
			})
		}
		result["models"] = modelList
		// Only do a full ping if a model is available.
		pingCtx, pingCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer pingCancel()
		if err := client.Ping(pingCtx, models[0].ID); err != nil {
			result["message"] = fmt.Sprintf("test request failed: %v", err)
		} else {
			result["testRequestOk"] = true
		}
	} else {
		result["message"] = "LM Studio is running, but no model is loaded"
	}
	writeOK(out, rid, result)
}

func handleGrammarCheck(req *protocol.Request, rid string, cfg HostConfig, out io.Writer) {
	var payload struct {
		Text         string  `json:"text"`
		SystemPrompt string  `json:"systemPrompt"`
		Model        string  `json:"model"`
		Temperature  float64 `json:"temperature"`
		MaxTokens    int     `json:"maxTokens"`
		TimeoutMs    int     `json:"timeoutMs"`
	}
	if err := json.Unmarshal(req.Payload, &payload); err != nil {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "malformed grammar_check payload")
		return
	}
	if payload.Text == "" {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "empty text")
		return
	}
	text, err := security.ClampText(payload.Text, security.MaxAnalyzeTextBytes)
	if err != nil {
		writeErr(out, rid, "REQUEST_TOO_LARGE", err.Error())
		return
	}
	sys, err := security.ClampText(payload.SystemPrompt, security.MaxSystemPromptBytes)
	if err != nil {
		writeErr(out, rid, "REQUEST_TOO_LARGE", err.Error())
		return
	}
	if payload.Model == "" {
		writeErr(out, rid, "LM_STUDIO_NO_MODEL", "no model selected")
		return
	}
	client, err := lmstudio.New(cfg.BaseURL, cfg.Token)
	if err != nil {
		writeErr(out, rid, "INSTALLATION_ERROR", err.Error())
		return
	}
	timeout := time.Duration(payload.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 60*time.Second {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out2, err := client.ChatCompletion(ctx, &lmstudio.ChatRequest{
		Model: payload.Model,
		Messages: []lmstudio.ChatMessage{
			{Role: "system", Content: sys},
			{Role: "user", Content: text},
		},
		Temperature: payload.Temperature,
		MaxTokens:   payload.MaxTokens,
	})
	if err != nil {
		writeErr(out, rid, classifyLMError(err), err.Error())
		return
	}
	writeOK(out, rid, map[string]any{"raw": out2})
}

func handleRewrite(req *protocol.Request, rid string, cfg HostConfig, out io.Writer) {
	var payload struct {
		Text         string  `json:"text"`
		SystemPrompt string  `json:"systemPrompt"`
		Model        string  `json:"model"`
		Temperature  float64 `json:"temperature"`
		MaxTokens    int     `json:"maxTokens"`
		TimeoutMs    int     `json:"timeoutMs"`
	}
	if err := json.Unmarshal(req.Payload, &payload); err != nil {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "malformed rewrite payload")
		return
	}
	if payload.Text == "" {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "empty text")
		return
	}
	text, err := security.ClampText(payload.Text, security.MaxRewriteTextBytes)
	if err != nil {
		writeErr(out, rid, "REQUEST_TOO_LARGE", err.Error())
		return
	}
	sys, err := security.ClampText(payload.SystemPrompt, security.MaxSystemPromptBytes)
	if err != nil {
		writeErr(out, rid, "REQUEST_TOO_LARGE", err.Error())
		return
	}
	if payload.Model == "" {
		writeErr(out, rid, "LM_STUDIO_NO_MODEL", "no model selected")
		return
	}
	client, err := lmstudio.New(cfg.BaseURL, cfg.Token)
	if err != nil {
		writeErr(out, rid, "INSTALLATION_ERROR", err.Error())
		return
	}
	timeout := time.Duration(payload.TimeoutMs) * time.Millisecond
	if timeout <= 0 || timeout > 60*time.Second {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out2, err := client.ChatCompletion(ctx, &lmstudio.ChatRequest{
		Model: payload.Model,
		Messages: []lmstudio.ChatMessage{
			{Role: "system", Content: sys},
			{Role: "user", Content: text},
		},
		Temperature: payload.Temperature,
		MaxTokens:   payload.MaxTokens,
	})
	if err != nil {
		writeErr(out, rid, classifyLMError(err), err.Error())
		return
	}
	writeOK(out, rid, map[string]any{"raw": out2})
}

func classifyLMError(err error) string {
	msg := err.Error()
	switch {
	case contains(msg, "connection refused"), contains(msg, "no such host"):
		return "LM_STUDIO_OFFLINE"
	case contains(msg, "context deadline exceeded"), contains(msg, "timeout"):
		return "LM_STUDIO_TIMEOUT"
	case contains(msg, "model error"):
		return "MODEL_ERROR"
	}
	return "MODEL_ERROR"
}

func contains(s, sub string) bool {
	return strings.Contains(s, sub)
}

func writeOK(w io.Writer, rid string, data any) {
	resp := protocol.NewOK(rid, data)
	if err := protocol.WriteResponse(w, resp); err != nil {
		logging.Error("WRITE_FAILED", err.Error())
	}
}

func writeErr(w io.Writer, rid, code, message string) {
	logging.Error(code, message)
	resp := protocol.NewErr(rid, code, message)
	if err := protocol.WriteResponse(w, resp); err != nil {
		logging.Error("WRITE_FAILED", err.Error())
	}
}

func hostVersion() string {
	return "1.1.0"
}

// loadConfig reads the optional host-config.json next to the executable
// and falls back to sane defaults. The file is created by the installer
// from the user's choices during setup, and can also be edited manually.
func loadConfig() HostConfig {
	cfg := HostConfig{
		BaseURL: "http://127.0.0.1:1234",
		Token:   "",
	}
	// Look next to the executable first.
	if exePath, err := os.Executable(); err == nil {
		path := exePath + ".config.json"
		if b, err := os.ReadFile(path); err == nil {
			var c HostConfig
			if json.Unmarshal(b, &c) == nil {
				if c.BaseURL != "" {
					cfg.BaseURL = c.BaseURL
				}
				cfg.Token = c.Token
			}
		}
	}
	// Also honor the conventional user-data location.
	if home, err := os.UserHomeDir(); err == nil {
		path := home + string(os.PathSeparator) + ".local-writing-assistant" + string(os.PathSeparator) + "host-config.json"
		if b, err := os.ReadFile(path); err == nil {
			var c HostConfig
			if json.Unmarshal(b, &c) == nil {
				if c.BaseURL != "" {
					cfg.BaseURL = c.BaseURL
				}
				cfg.Token = c.Token
			}
		}
	}
	return cfg
}

// handleGrammarCheckMock answers a grammar_check request using the
// deterministic in-process mock instead of contacting LM Studio.
// Used by automated tests (spec section 56).
func handleGrammarCheckMock(req *protocol.Request, rid string, out io.Writer) {
	var payload struct {
		Text         string  `json:"text"`
		SystemPrompt string  `json:"systemPrompt"`
		Model        string  `json:"model"`
		Temperature  float64 `json:"temperature"`
		MaxTokens    int     `json:"maxTokens"`
		TimeoutMs    int     `json:"timeoutMs"`
	}
	if err := json.Unmarshal(req.Payload, &payload); err != nil {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "malformed grammar_check payload")
		return
	}
	if payload.Text == "" {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "empty text")
		return
	}
	text, err := security.ClampText(payload.Text, security.MaxAnalyzeTextBytes)
	if err != nil {
		writeErr(out, rid, "REQUEST_TOO_LARGE", err.Error())
		return
	}
	writeOK(out, rid, map[string]any{"raw": mock.GrammarResponse(text), "mock": true})
}

// handleRewriteMock answers a rewrite request using the deterministic
// in-process mock. Used by automated tests (spec section 56).
func handleRewriteMock(req *protocol.Request, rid string, out io.Writer) {
	var payload struct {
		Text         string  `json:"text"`
		SystemPrompt string  `json:"systemPrompt"`
		Model        string  `json:"model"`
		Temperature  float64 `json:"temperature"`
		MaxTokens    int     `json:"maxTokens"`
		TimeoutMs    int     `json:"timeoutMs"`
	}
	if err := json.Unmarshal(req.Payload, &payload); err != nil {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "malformed rewrite payload")
		return
	}
	if payload.Text == "" {
		writeErr(out, rid, "INVALID_AI_RESPONSE", "empty text")
		return
	}
	text, err := security.ClampText(payload.Text, security.MaxRewriteTextBytes)
	if err != nil {
		writeErr(out, rid, "REQUEST_TOO_LARGE", err.Error())
		return
	}
	writeOK(out, rid, map[string]any{"raw": mock.RewriteResponse(text), "mock": true})
}
