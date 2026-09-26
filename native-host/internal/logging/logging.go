// Package logging writes local-only diagnostic logs to stderr.
//
// Per the spec (section 35), we never include the user's full writing in
// ordinary logs. Log messages describe request lifecycle, model state,
// and errors — never the body of a grammar_check / rewrite request.
package logging

import (
	"fmt"
	"os"
	"sync"
	"time"
)

var (
	mu  sync.Mutex
	out = os.Stderr
)

// Level is a coarse log level.
type Level string

const (
	LevelInfo  Level = "INFO"
	LevelWarn  Level = "WARN"
	LevelError Level = "ERROR"
)

// Log writes a single structured line to stderr.
func Log(level Level, code, message string) {
	mu.Lock()
	defer mu.Unlock()
	ts := time.Now().Format("2006-01-02T15:04:05.000Z07:00")
	fmt.Fprintf(out, "%s [%s] %s: %s\n", ts, level, code, message)
}

// Info is a shorthand for Log(LevelInfo, …).
func Info(code, message string) { Log(LevelInfo, code, message) }

// Warn is a shorthand for Log(LevelWarn, …).
func Warn(code, message string) { Log(LevelWarn, code, message) }

// Error is a shorthand for Log(LevelError, …).
func Error(code, message string) { Log(LevelError, code, message) }
