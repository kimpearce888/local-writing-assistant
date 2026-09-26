// Package lmstudio talks to the local LM Studio OpenAI-compatible API.
//
// The HTTP client is constrained to localhost only — we use a custom
// transport that rejects any non-loopback dial. This is defense in depth:
// even if SanitizeLMStudioURL were bypassed, the dialer would still
// refuse to connect anywhere but 127.0.0.1.
package lmstudio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"localwritingassistant.host/internal/security"
)

// Client is a constrained HTTP client that ONLY dials loopback hosts.
type Client struct {
	baseURL string
	http    *http.Client
	token   string
}

// New builds a Client for the given (already-sanitized) base URL.
func New(baseURL, token string) (*Client, error) {
	clean, err := security.SanitizeLMStudioURL(baseURL)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{
		// Reasonable per-dial timeouts.
		Timeout: 5 * time.Second,
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, _ := net.SplitHostPort(addr)
			ip := net.ParseIP(host)
			if ip == nil {
				if !isLoopbackHost(host) {
					return nil, fmt.Errorf("refusing non-local host: %s", host)
				}
				ip = net.ParseIP("127.0.0.1")
				if ip == nil {
					ip = net.IPv4(127, 0, 0, 1)
				}
			}
			if !ip.IsLoopback() {
				return nil, fmt.Errorf("refusing non-local ip: %s", ip)
			}
			return dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		},
		// No proxy — we don't want to accidentally tunnel.
		Proxy: nil,
	}
	return &Client{
		baseURL: clean,
		http: &http.Client{
			Transport: transport,
			// We use context per-request for timeout control.
			Timeout: 0,
		},
		token: token,
	}, nil
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// Model represents a single LM Studio model entry.
type Model struct {
	ID      string `json:"id"`
	Object  string `json:"object,omitempty"`
	OwnedBy string `json:"owned_by,omitempty"`
}

// ListModels hits GET /v1/models.
func (c *Client) ListModels(ctx context.Context) ([]Model, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("models endpoint returned %d: %s", resp.StatusCode, string(body))
	}
	var parsed struct {
		Data []Model `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode models: %w", err)
	}
	return parsed.Data, nil
}

// ChatMessage is a single OpenAI-style chat message.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest is the OpenAI-compatible chat completions request body.
type ChatRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Stream      bool          `json:"stream"`
}

// ChatCompletion POSTs to /v1/chat/completions and returns the first
// assistant message's content. The body is limited to a safe maximum.
func (c *Client) ChatCompletion(ctx context.Context, req *ChatRequest) (string, error) {
	if req == nil {
		return "", fmt.Errorf("nil request")
	}
	if req.Model == "" {
		return "", fmt.Errorf("no model selected")
	}
	if req.Temperature < 0 {
		req.Temperature = 0
	}
	if req.MaxTokens <= 0 {
		req.MaxTokens = 1024
	}
	req.Stream = false
	body, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("marshal chat request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(
		ctx, "POST", c.baseURL+"/v1/chat/completions", bytes.NewReader(body),
	)
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("chat completions returned %d: %s", resp.StatusCode, string(respBody))
	}
	var parsed struct {
		Choices []struct {
			Message ChatMessage `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&parsed); err != nil {
		return "", fmt.Errorf("decode chat response: %w", err)
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return "", fmt.Errorf("model error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("model returned no choices")
	}
	return parsed.Choices[0].Message.Content, nil
}

// Ping sends a tiny chat completion request to verify the full path works.
func (c *Client) Ping(ctx context.Context, model string) error {
	_, err := c.ChatCompletion(ctx, &ChatRequest{
		Model:       model,
		Messages:    []ChatMessage{{Role: "system", Content: "Return only JSON: {\"ok\":true}"}},
		Temperature: 0,
		MaxTokens:   16,
	})
	return err
}
