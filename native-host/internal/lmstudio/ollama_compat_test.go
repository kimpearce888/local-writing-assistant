package lmstudio

// Ollama OpenAI-compatibility — closes the long-standing "Ollama path
// untested" open item. The extension's endpoint config accepts any
// loopback OpenAI-shaped base URL, and Ollama serves exactly that wire
// format on 127.0.0.1:11434 via its OpenAI-compatibility layer. This test
// mimics Ollama's compat-layer quirks:
//
//   - model ids carry Ollama tags ("llama3.2:latest")
//   - chat responses omit fields LM Studio sends ("created", "usage")
//     and advertise "X-Ollama-Server-Version"
//   - plain loopback HTTP, no TLS, no API token
//
// and asserts the client works against it UNCHANGED — i.e. nothing in the
// client secretly requires LM Studio-specific response fields. A live
// Ollama install with real models remains the deployment-time check; the
// wire format is what this suite can and does prove.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOllamaShapedCompat(t *testing.T) {
	type chatReqBody struct {
		Model       string  `json:"model"`
		MaxTokens   int     `json:"max_tokens"`
		Stream      bool    `json:"stream"`
		Temperature float64 `json:"temperature"`
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Ollama-Server-Version", "0.5.4")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"object":"list","data":[`+
			`{"id":"llama3.2:latest","object":"model","owned_by":"library"},`+
			`{"id":"qwen2.5-coder:14b","object":"model"}]}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var req chatReqBody
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("decode request body: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if req.Model != "llama3.2:latest" {
			t.Errorf("request model = %q, want the tagged Ollama id", req.Model)
		}
		if req.Stream {
			t.Errorf("request stream = true; client must use non-streaming completions")
		}
		if req.MaxTokens <= 0 {
			t.Errorf("request max_tokens = %d; client must send a sane cap", req.MaxTokens)
		}
		// Ollama-shaped response: deliberately NO "created" and NO "usage".
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"cmpl-ollama","object":"chat.completion","model":"llama3.2:latest",`+
			`"choices":[{"index":0,"message":{"role":"assistant","content":"Rewritten by an Ollama-shaped backend."},"finish_reason":"stop"}]}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New(%q): %v", srv.URL, err)
	}
	ctx := context.Background()

	models, err := c.ListModels(ctx)
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if len(models) != 2 || models[0].ID != "llama3.2:latest" {
		t.Fatalf("ListModels = %+v, want tagged Ollama ids", models)
	}

	out, err := c.ChatCompletion(ctx, &ChatRequest{
		Model:    "llama3.2:latest",
		Messages: []ChatMessage{{Role: "user", Content: "Rewrite: its a nice day"}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if !strings.Contains(out, "Ollama-shaped backend") {
		t.Fatalf("ChatCompletion = %q, want the Ollama-shaped content", out)
	}

	if err := c.Ping(ctx, "llama3.2:latest"); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}
