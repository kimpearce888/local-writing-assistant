package lmstudio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestChatCompletion_RejectsCrossHostRedirect verifies the belt-and-braces
// redirect policy: a compromised/redirecting loopback endpoint must not be
// able to bounce a request (and its Authorization header) to a non-local
// host. The loopback dialer would refuse the connection anyway; this test
// proves the redirect is rejected BEFORE any dial to the rogue target.
func TestChatCompletion_RejectsCrossHostRedirect(t *testing.T) {
	var outerURL string
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Target that the dialer must refuse (and CheckRedirect must reject).
		target, _ := url.Parse(outerURL)
		target.Host = "169.254.169.254:80" // cloud-metadata-style address
		http.Redirect(w, r, target.String(), http.StatusFound)
	}))
	defer inner.Close()

	outerURL = inner.URL // same loopback host:port as the allowed base URL

	c, err := New(inner.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = c.ChatCompletion(ctx, &ChatRequest{
		Model:    "test-model",
		Messages: []ChatMessage{{Role: "user", Content: "hi"}},
	})
	if err == nil {
		t.Fatal("expected redirect to non-local host to be rejected")
	}
	if !strings.Contains(err.Error(), "refusing cross-host redirect") &&
		!strings.Contains(err.Error(), "refusing non-local") {
		t.Fatalf("expected redirect/dial rejection, got: %v", err)
	}
}

// TestChatCompletion_ClampsRequestValues checks the extension-controlled
// Temperature/MaxTokens clamps (audit GO-209) by capturing the body the
// client actually sends.
func TestChatCompletion_ClampsRequestValues(t *testing.T) {
	var gotTemperature float64
	var gotMaxTokens int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Temperature float64 `json:"temperature"`
			MaxTokens   int     `json:"max_tokens"`
		}
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		gotTemperature = body.Temperature
		gotMaxTokens = body.MaxTokens
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer srv.Close()

	c, err := New(srv.URL, "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.ChatCompletion(ctx, &ChatRequest{
		Model:       "m",
		Messages:    []ChatMessage{{Role: "user", Content: "hi"}},
		Temperature: 1e9,
		MaxTokens:   2_000_000_000,
	}); err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}
	if gotTemperature != 2 {
		t.Errorf("temperature not clamped: got %v", gotTemperature)
	}
	if gotMaxTokens != 8192 {
		t.Errorf("max_tokens not clamped: got %v", gotMaxTokens)
	}
}
