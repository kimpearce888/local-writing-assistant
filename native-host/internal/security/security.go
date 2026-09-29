// Package security enforces the host's network and payload boundaries.
//
// Per spec section 34:
//   - Only 127.0.0.1 / localhost are permitted as LM Studio destinations.
//   - The extension must NEVER be able to use the host as a general
//     purpose command runner. We do not expose any command that runs
//     shell, PowerShell, cmd, bash, or eval.
//   - Payload sizes are clamped to conservative limits.
package security

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"unicode/utf8"
)

// Allowed LM Studio hosts. Anything else (including 0.0.0.0, LAN IPs,
// public DNS names) is rejected.
var allowedHosts = map[string]bool{
	"127.0.0.1": true,
	"localhost": true,
	"::1":       true,
}

// MaxAnalyzeTextBytes caps a single grammar-check payload.
const MaxAnalyzeTextBytes = 8000

// MaxRewriteTextBytes caps a single rewrite payload.
const MaxRewriteTextBytes = 8000

// MaxSystemPromptBytes caps the system prompt (the extension provides it,
// but we still clamp to prevent a runaway payload from blowing memory).
const MaxSystemPromptBytes = 8000

// MaxURLBytes is the maximum length of the LM Studio base URL we accept.
const MaxURLBytes = 256

// SanitizeLMStudioURL parses, validates, and normalizes the user-supplied
// LM Studio base URL. Returns an error if the URL is not on the local
// loopback or is otherwise suspicious.
func SanitizeLMStudioURL(raw string) (string, error) {
	if raw == "" {
		return "http://127.0.0.1:1234", nil
	}
	if len(raw) > MaxURLBytes {
		return "", errors.New("lm studio url too long")
	}
	// Reject obvious trickery before parsing.
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "@") {
		return "", errors.New("userinfo not permitted in lm studio url")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("only http(s) schemes are permitted")
	}
	host := strings.ToLower(u.Hostname())
	if !allowedHosts[host] {
		// Allow any IPv4/IPv6 loopback literal as well (e.g. 127.x.y.z).
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			// fallthrough — permitted
		} else {
			return "", fmt.Errorf("host %q is not local; only 127.0.0.1/localhost permitted", host)
		}
	}
	// Rebuild without userinfo, fragment, or query — we only need scheme+host+port.
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	// net.JoinHostPort adds brackets around IPv6 literals — without
	// those, an IPv6 base URL like http://::1:1234 is malformed and
	// every subsequent http.NewRequest would fail.
	return fmt.Sprintf("%s://%s", u.Scheme, net.JoinHostPort(host, port)), nil
}

// IsAllowedCommand returns true if `cmd` is one of the known commands
// the host is allowed to execute. Anything else is rejected with an
// UNKNOWN_COMMAND error.
func IsAllowedCommand(cmd string) bool {
	switch cmd {
	case "ping", "get_config", "get_models", "check_connection", "grammar_check", "rewrite":
		return true
	}
	return false
}

// ClampText returns s truncated to maxBytes. Returns an error if s is
// already too large to ever be accepted. The truncation is rune-aware
// so we never slice a multi-byte UTF-8 character in half (which would
// produce invalid UTF-8 and could confuse the LLM or break JSON
// marshalling downstream).
func ClampText(s string, maxBytes int) (string, error) {
	if len(s) > maxBytes {
		// Suspiciously large — reject outright so we don't allocate.
		if len(s) > maxBytes*2 {
			return "", fmt.Errorf("text length %d exceeds %d", len(s), maxBytes)
		}
		// Truncate at the last rune boundary at or before maxBytes.
		truncated := s[:maxBytes]
		// Walk back until we're on a rune start byte.
		for len(truncated) > 0 && !utf8.ValidString(truncated) {
			// Lop off the last byte and try again. We're guaranteed
			// to land on a valid boundary eventually because at byte
			// 0 the empty string is trivially valid.
			truncated = truncated[:len(truncated)-1]
		}
		return truncated, nil
	}
	return s, nil
}
