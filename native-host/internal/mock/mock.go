// Package mock implements a deterministic offline AI for use in automated
// tests and CI (spec section 56).
//
// When the host binary is launched with the LOCAL_MOCK_AI=true environment
// variable, every grammar_check / rewrite request is answered by this
// package instead of forwarding to LM Studio. The mock NEVER makes any
// network call — it is purely in-process.
//
// Mock responses are intentionally minimal but structurally valid:
//   - grammar_check returns a fixed issue list for the famous "She don't"
//     subject-verb-agreement case
//   - rewrite returns a deterministic transformation
//
// This is enough for the Playwright E2E suite to exercise the full
// content-script → service-worker → native-messaging → host → response
// pipeline without needing an actual local LLM running.
package mock

import (
	"encoding/json"
	"os"
	"strings"
)

// Enabled reports whether mock mode is active (LOCAL_MOCK_AI=true).
func Enabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LOCAL_MOCK_AI")))
	return v == "true" || v == "1" || v == "yes"
}

// GrammarResponse returns a deterministic, structurally-valid grammar
// response for the given analyzed text.
//
// If the text contains "don't", we return a single grammar issue
// flagging it as a subject-verb-agreement error and proposing
// "doesn't". Otherwise we return an empty issue list.
func GrammarResponse(analyzedText string) string {
	issues := []map[string]any{}
	if idx := strings.Index(analyzedText, "don't"); idx >= 0 {
		issues = append(issues, map[string]any{
			"id":          "mock-issue-1",
			"start":       idx,
			"end":         idx + len("don't"),
			"original":    "don't",
			"replacement": "doesn't",
			"category":    "grammar",
			"explanation": "Subject-verb agreement (mock response).",
			"confidence":  0.95,
		})
	}
	resp := map[string]any{
		"issues":        issues,
		"correctedText": strings.Replace(analyzedText, "don't", "doesn't", 1),
	}
	b, _ := json.Marshal(resp)
	return string(b)
}

// RewriteResponse returns a deterministic rewrite result.
func RewriteResponse(input string) string {
	resp := map[string]any{
		"rewritten":   strings.ToUpper(input),
		"explanation": "Mock rewrite: uppercased the input.",
	}
	b, _ := json.Marshal(resp)
	return string(b)
}

// ModelsResponse returns a deterministic model list for get_models.
func ModelsResponse() string {
	resp := map[string]any{
		"models": []map[string]any{
			{"id": "mock-model-1", "object": "model", "owned_by": "mock"},
		},
	}
	b, _ := json.Marshal(resp)
	return string(b)
}

// CheckConnectionResponse returns the full check_connection payload.
func CheckConnectionResponse() string {
	resp := map[string]any{
		"nativeHost":        true,
		"lmStudioReachable": true,
		"modelsEndpointOk":  true,
		"atLeastOneModel":   true,
		"testRequestOk":     true,
		"models": []map[string]any{
			{"id": "mock-model-1"},
		},
		"message": "LOCAL_MOCK_AI mode — no real LM Studio contacted",
	}
	b, _ := json.Marshal(resp)
	return string(b)
}
