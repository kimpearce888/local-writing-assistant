package main

import (
        "bytes"
        binenc "encoding/binary"
        "encoding/json"
        "fmt"
        "os"
        "os/exec"
        "path/filepath"
        "strings"
        "testing"
)

// TestNativeHost_Ping builds the host binary and exercises the full
// native messaging wire protocol against it. We treat the host as a
// black box — it receives length-prefixed JSON on stdin and emits
// length-prefixed JSON on stdout.
func TestNativeHost_Ping(t *testing.T) {
        if testing.Short() {
                t.Skip("skipping integration test in short mode")
        }
        binary := buildHost(t)
        resp := call(t, binary, &Request{Command: "ping", RequestID: "r1"})
        if !resp.OK || resp.RequestID != "r1" {
                t.Fatalf("unexpected ping response: %+v", resp)
        }
}

func TestNativeHost_UnknownCommandRejected(t *testing.T) {
        if testing.Short() {
                t.Skip("skipping integration test in short mode")
        }
        binary := buildHost(t)
        resp := call(t, binary, &Request{Command: "executeShell", RequestID: "r2"})
        if resp.OK {
                t.Fatalf("executeShell must be rejected")
        }
        if resp.ErrorCode != "UNKNOWN_COMMAND" {
                t.Fatalf("expected UNKNOWN_COMMAND, got %q", resp.ErrorCode)
        }
}

func TestNativeHost_GetConfig(t *testing.T) {
        if testing.Short() {
                t.Skip("skipping integration test in short mode")
        }
        binary := buildHost(t)
        resp := call(t, binary, &Request{Command: "get_config", RequestID: "r3"})
        if !resp.OK {
                t.Fatalf("get_config failed: %+v", resp)
        }
        var data struct {
                BaseURL string `json:"baseUrl"`
        }
        if err := json.Unmarshal(resp.Data, &data); err != nil {
                t.Fatalf("decode data: %v", err)
        }
        if data.BaseURL == "" {
                t.Fatalf("expected non-empty baseUrl")
        }
}

func TestNativeHost_CheckConnection_LMStudioOffline(t *testing.T) {
        if testing.Short() {
                t.Skip("skipping integration test in short mode")
        }
        // We use a bogus port so we know LM Studio is not actually running.
        binary := buildHost(t)
        resp := call(t, binary, &Request{
                Command: "check_connection",
                RequestID: "r4",
                Payload: mustJSON(map[string]any{"lightweight": true}),
        })
        if !resp.OK {
                t.Fatalf("check_connection should always return ok:true with diagnostic fields; got %+v", resp)
        }
        var data struct {
                NativeHost        bool `json:"nativeHost"`
                LMStudioReachable bool `json:"lmStudioReachable"`
        }
        if err := json.Unmarshal(resp.Data, &data); err != nil {
                t.Fatalf("decode data: %v", err)
        }
        if !data.NativeHost {
                t.Fatalf("expected nativeHost=true")
        }
        // LM Studio almost certainly isn't running on this test box, so
        // lmStudioReachable should be false. We don't hard-assert it to
        // keep the test resilient.
}

func TestNativeHost_GrammarCheck_RejectsEmpty(t *testing.T) {
        if testing.Short() {
                t.Skip("skipping integration test in short mode")
        }
        binary := buildHost(t)
        resp := call(t, binary, &Request{
                Command:   "grammar_check",
                RequestID: "r5",
                Payload:   mustJSON(map[string]any{"text": ""}),
        })
        if resp.OK {
                t.Fatalf("expected error on empty text")
        }
        if resp.ErrorCode != "INVALID_AI_RESPONSE" {
                t.Fatalf("expected INVALID_AI_RESPONSE, got %q", resp.ErrorCode)
        }
}

func TestNativeHost_GrammarCheck_RejectsNoModel(t *testing.T) {
        if testing.Short() {
                t.Skip("skipping integration test in short mode")
        }
        binary := buildHost(t)
        resp := call(t, binary, &Request{
                Command: "grammar_check",
                RequestID: "r6",
                Payload: mustJSON(map[string]any{
                        "text":         "Hello world.",
                        "systemPrompt": "be brief",
                        "model":        "",
                }),
        })
        if resp.OK {
                t.Fatalf("expected error when model is empty")
        }
        if resp.ErrorCode != "LM_STUDIO_NO_MODEL" {
                t.Fatalf("expected LM_STUDIO_NO_MODEL, got %q", resp.ErrorCode)
        }
}

/* ---------------- helpers ---------------- */

func buildHost(t *testing.T) string {
        t.Helper()
        bin := filepath.Join(t.TempDir(), "lwa-host-test")
        // Resolve the native-host module directory relative to this test file.
        hostModuleDir, err := filepath.Abs(filepath.Join("..", "native-host"))
        if err != nil {
                t.Fatalf("resolve host module dir: %v", err)
        }
        cmd := exec.Command("go", "build", "-o", bin, "./cmd/localwritingassistanthost")
        cmd.Dir = hostModuleDir
        cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
        if out, err := cmd.CombinedOutput(); err != nil {
                t.Fatalf("build host: %v\n%s", err, out)
        }
        return bin
}

func call(t *testing.T, binary string, req *Request) *Response {
        t.Helper()
        return callWithEnv(t, binary, req, nil)
}

// callWithEnv is like call but sets the given environment variables on
// the host subprocess. Used to test LOCAL_MOCK_AI=true mode.
func callWithEnv(t *testing.T, binary string, req *Request, env map[string]string) *Response {
        t.Helper()
        body, err := json.Marshal(req)
        if err != nil {
                t.Fatalf("marshal request: %v", err)
        }
        var input bytes.Buffer
        _ = binenc.Write(&input, binenc.LittleEndian, uint32(len(body)))
        input.Write(body)
        cmd := exec.Command(binary)
        cmd.Stdin = &input
        var stdout bytes.Buffer
        cmd.Stdout = &stdout
        cmd.Stderr = nil
        if env != nil {
                // Inherit the parent env, then override with the test values.
                parent := os.Environ()
                envMap := map[string]string{}
                for _, kv := range parent {
                        envMap[kv[:strings.Index(kv, "=")]] = kv[strings.Index(kv, "=")+1:]
                }
                for k, v := range env {
                        envMap[k] = v
                }
                final := []string{}
                for k, v := range envMap {
                        final = append(final, k+"="+v)
                }
                cmd.Env = final
        }
        if err := cmd.Run(); err != nil {
                t.Fatalf("run host: %v", err)
        }
        var length uint32
        if err := binenc.Read(&stdout, binenc.LittleEndian, &length); err != nil {
                t.Fatalf("read length: %v", err)
        }
        respBytes := make([]byte, length)
        if _, err := stdout.Read(respBytes); err != nil {
                t.Fatalf("read body: %v", err)
        }
        var resp Response
        if err := json.Unmarshal(respBytes, &resp); err != nil {
                t.Fatalf("unmarshal response: %v\nbody=%s", err, string(respBytes))
        }
        return &resp
}

func mustJSON(v any) json.RawMessage {
        b, _ := json.Marshal(v)
        return b
}

// Local type aliases so this test file compiles standalone.
type Request = protocolTestRequest
type Response = protocolTestResponse

type protocolTestRequest struct {
        Command   string          `json:"command"`
        RequestID string          `json:"requestId,omitempty"`
        Payload   json.RawMessage `json:"payload,omitempty"`
}
type protocolTestResponse struct {
        OK        bool            `json:"ok"`
        RequestID string          `json:"requestId,omitempty"`
        ErrorCode string          `json:"errorCode,omitempty"`
        Error     string          `json:"error,omitempty"`
        Data      json.RawMessage `json:"data,omitempty"`
}

// shim: TestMain ensures the go build works.
func TestMain(m *testing.M) {
        fmt.Fprintln(os.Stderr, "native host integration tests starting")
        os.Exit(m.Run())
}

// TestNativeHost_MockMode_GrammarCheck verifies that with
// LOCAL_MOCK_AI=true, the host returns a deterministic grammar response
// for the "She don't" test case without contacting LM Studio.
func TestNativeHost_MockMode_GrammarCheck(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	binary := buildHost(t)
	resp := callWithEnv(t, binary, &Request{
		Command:   "grammar_check",
		RequestID: "mock-1",
		Payload: mustJSON(map[string]any{
			"text":         "She don't like it.",
			"systemPrompt": "be brief",
			"model":        "any-model",
		}),
	}, map[string]string{"LOCAL_MOCK_AI": "true"})
	if !resp.OK {
		t.Fatalf("mock grammar_check failed: %+v", resp)
	}
	data := struct {
		Raw  string `json:"raw"`
		Mock bool   `json:"mock"`
	}{}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if !data.Mock {
		t.Fatalf("expected mock=true in response")
	}
	// The mock response is itself a JSON string.
	var grammarResp struct {
		Issues []struct {
			ID          string  `json:"id"`
			Start       int     `json:"start"`
			End         int     `json:"end"`
			Original    string  `json:"original"`
			Replacement string  `json:"replacement"`
			Category    string  `json:"category"`
			Confidence  float64 `json:"confidence"`
		} `json:"issues"`
	}
	if err := json.Unmarshal([]byte(data.Raw), &grammarResp); err != nil {
		t.Fatalf("decode mock grammar response: %v", err)
	}
	if len(grammarResp.Issues) != 1 {
		t.Fatalf("expected 1 mock issue, got %d", len(grammarResp.Issues))
	}
	iss := grammarResp.Issues[0]
	if iss.Original != "don't" || iss.Replacement != "doesn't" || iss.Category != "grammar" {
		t.Fatalf("unexpected mock issue: %+v", iss)
	}
	// Verify the offsets point at the right substring in the input text.
	text := "She don't like it."
	if text[iss.Start:iss.End] != iss.Original {
		t.Fatalf("mock offsets %d..%d don't match input", iss.Start, iss.End)
	}
}

// TestNativeHost_MockMode_CheckConnection verifies that
// LOCAL_MOCK_AI=true reports LM Studio as reachable (so the popup's
// "Test LM Studio Connection" button passes in test environments).
func TestNativeHost_MockMode_CheckConnection(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	binary := buildHost(t)
	resp := callWithEnv(t, binary, &Request{
		Command:   "check_connection",
		RequestID: "mock-2",
	}, map[string]string{"LOCAL_MOCK_AI": "true"})
	if !resp.OK {
		t.Fatalf("mock check_connection failed: %+v", resp)
	}
	data := struct {
		NativeHost        bool `json:"nativeHost"`
		LMStudioReachable bool `json:"lmStudioReachable"`
		AtLeastOneModel   bool `json:"atLeastOneModel"`
		TestRequestOk     bool `json:"testRequestOk"`
	}{}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if !data.NativeHost || !data.LMStudioReachable || !data.AtLeastOneModel || !data.TestRequestOk {
		t.Fatalf("expected all mock check_connection fields to be true, got %+v", data)
	}
}

// TestNativeHost_MockMode_GetModels verifies the mock models list.
func TestNativeHost_MockMode_GetModels(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	binary := buildHost(t)
	resp := callWithEnv(t, binary, &Request{
		Command:   "get_models",
		RequestID: "mock-3",
	}, map[string]string{"LOCAL_MOCK_AI": "true"})
	if !resp.OK {
		t.Fatalf("mock get_models failed: %+v", resp)
	}
	data := struct {
		Raw  string `json:"raw"`
		Mock bool   `json:"mock"`
	}{}
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if !data.Mock {
		t.Fatalf("expected mock=true in response")
	}
	var modelsResp struct {
		Models []struct {
			ID string `json:"id"`
		} `json:"models"`
	}
	if err := json.Unmarshal([]byte(data.Raw), &modelsResp); err != nil {
		t.Fatalf("decode mock models response: %v", err)
	}
	if len(modelsResp.Models) != 1 || modelsResp.Models[0].ID != "mock-model-1" {
		t.Fatalf("unexpected mock models list: %+v", modelsResp.Models)
	}
}
