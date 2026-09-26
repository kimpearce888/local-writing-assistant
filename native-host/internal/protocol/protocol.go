// Package protocol implements Chrome's Native Messaging wire format
// (length-prefixed JSON over stdin/stdout) plus the request/response
// envelopes used by the Local Writing Assistant extension.
//
// Security notes:
//   - We never write anything to stdout that isn't a single length-prefixed
//     JSON message. Logs go to stderr only.
//   - We hard-cap the incoming message size to protect the host from
//     malicious oversized payloads.
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// MaxMessageBytes is the absolute upper bound for a single native message.
// Chrome itself uses a 1 MiB cap on the inbound side; we keep the same.
const MaxMessageBytes = 1024 * 1024

// Request is the envelope sent by the extension.
type Request struct {
	Command   string          `json:"command"`
	RequestID string          `json:"requestId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Response is the envelope returned by the host.
type Response struct {
	OK        bool            `json:"ok"`
	RequestID string          `json:"requestId,omitempty"`
	ErrorCode string          `json:"errorCode,omitempty"`
	Error     string          `json:"error,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

// ReadRequest reads a single length-prefixed message from r and unmarshals
// it. Returns an error if the message is missing, oversized, or malformed.
func ReadRequest(r io.Reader) (*Request, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("read length: %w", err)
	}
	if length == 0 {
		return nil, errors.New("zero-length message")
	}
	if int64(length) > MaxMessageBytes {
		return nil, fmt.Errorf("message too large: %d bytes (max %d)", length, MaxMessageBytes)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	var req Request
	if err := json.Unmarshal(buf, &req); err != nil {
		return nil, fmt.Errorf("unmarshal request: %w", err)
	}
	return &req, nil
}

// WriteResponse marshals a Response and writes it as a length-prefixed
// message to w. Never writes anything else to w.
func WriteResponse(w io.Writer, resp *Response) error {
	body, err := json.Marshal(resp)
	if err != nil {
		// Fallback: send a generic error envelope.
		body, _ = json.Marshal(&Response{
			OK:        false,
			RequestID: resp.RequestID,
			ErrorCode: "INTERNAL_ERROR",
			Error:     "failed to marshal response",
		})
	}
	if len(body) > MaxMessageBytes {
		body, _ = json.Marshal(&Response{
			OK:        false,
			RequestID: resp.RequestID,
			ErrorCode: "INTERNAL_ERROR",
			Error:     "response too large",
		})
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(body))); err != nil {
		return err
	}
	if _, err := w.Write(body); err != nil {
		return err
	}
	return nil
}

// NewOK builds a successful response with the given data.
func NewOK(requestID string, data any) *Response {
	raw, err := json.Marshal(data)
	if err != nil {
		return &Response{
			OK:        false,
			RequestID: requestID,
			ErrorCode: "INTERNAL_ERROR",
			Error:     "failed to marshal data",
		}
	}
	return &Response{OK: true, RequestID: requestID, Data: raw}
}

// NewErr builds an error response.
func NewErr(requestID, code, message string) *Response {
	return &Response{
		OK:        false,
		RequestID: requestID,
		ErrorCode: code,
		Error:     message,
	}
}
