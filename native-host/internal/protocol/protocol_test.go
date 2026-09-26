package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

func TestWriteThenReadRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	resp := NewOK("rid-1", map[string]any{"hello": "world"})
	if err := WriteResponse(&buf, resp); err != nil {
		t.Fatalf("WriteResponse: %v", err)
	}
	// Read length back.
	var length uint32
	if err := binary.Read(&buf, binary.LittleEndian, &length); err != nil {
		t.Fatalf("read length: %v", err)
	}
	body := make([]byte, length)
	if _, err := buf.Read(body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	var got Response
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK || got.RequestID != "rid-1" {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func TestReadRequestRejectsOversized(t *testing.T) {
	var buf bytes.Buffer
	// Write a fake length that exceeds MaxMessageBytes.
	_ = binary.Write(&buf, binary.LittleEndian, uint32(MaxMessageBytes+1))
	_, err := ReadRequest(&buf)
	if err == nil {
		t.Fatalf("expected error for oversized message")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReadRequestRejectsMalformed(t *testing.T) {
	var buf bytes.Buffer
	body := []byte("{not valid json")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(len(body)))
	buf.Write(body)
	_, err := ReadRequest(&buf)
	if err == nil {
		t.Fatalf("expected error for malformed JSON")
	}
}

func TestNewErrShape(t *testing.T) {
	r := NewErr("rid-2", "LM_STUDIO_OFFLINE", "down")
	if r.OK || r.ErrorCode != "LM_STUDIO_OFFLINE" || r.Error != "down" {
		t.Fatalf("bad error envelope: %+v", r)
	}
}
