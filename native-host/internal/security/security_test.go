package security

import "testing"

func TestSanitizeLMStudioURL_Allows(t *testing.T) {
	cases := []string{
		"http://127.0.0.1:1234",
		"http://localhost:1234",
		"http://127.0.0.1",
		"https://127.0.0.1:443",
	}
	for _, raw := range cases {
		if _, err := SanitizeLMStudioURL(raw); err != nil {
			t.Errorf("expected %q to be allowed, got %v", raw, err)
		}
	}
}

func TestSanitizeLMStudioURL_Rejects(t *testing.T) {
	cases := []string{
		"http://192.168.1.5:1234",         // LAN
		"http://10.0.0.1:1234",            // private network
		"http://example.com:1234",         // public host
		"http://0.0.0.0:1234",             // wildcard
		"ftp://127.0.0.1:1234",            // non-http scheme
		"http://user:pass@127.0.0.1:1234", // userinfo
		"",
	}
	for _, raw := range cases {
		// Empty string is allowed (defaults to 127.0.0.1).
		if raw == "" {
			continue
		}
		_, err := SanitizeLMStudioURL(raw)
		if err == nil {
			t.Errorf("expected %q to be rejected", raw)
		}
	}
}

func TestIsAllowedCommand(t *testing.T) {
	allowed := []string{
		"ping", "get_config", "get_models",
		"check_connection", "grammar_check", "rewrite",
	}
	for _, c := range allowed {
		if !IsAllowedCommand(c) {
			t.Errorf("expected %q to be allowed", c)
		}
	}
	forbidden := []string{
		"runCommand", "executeShell", "powershell", "cmd",
		"bash", "eval", "exec", "system", "subprocess", "fork",
		"", "unknown",
	}
	for _, c := range forbidden {
		if IsAllowedCommand(c) {
			t.Errorf("expected %q to be forbidden", c)
		}
	}
}

func TestClampText(t *testing.T) {
	if out, err := ClampText("hello", 10); err != nil || out != "hello" {
		t.Fatalf("short text should pass; got %q %v", out, err)
	}
	if out, err := ClampText("hello", 3); err != nil || out != "hel" {
		t.Fatalf("truncation should work; got %q %v", out, err)
	}
	if _, err := ClampText(string(make([]byte, 100000)), 100); err == nil {
		t.Fatalf("huge input should be rejected")
	}
}
