package importer

import (
	"encoding/json"
	"log"
	"os"
)

// This file ports routes/import.js's debugLog(message) call sites (#977
// follow-up: debug_logging wasn't wired into any Go package yet). The
// options.json read is a narrow, single-field duplicate of
// go/internal/system's own copy (see that package's options.go), not an
// import of it — this package doesn't otherwise depend on internal/system,
// and internal/system already depends on internal/machines, so importing
// it here risks a cycle for one bool. go/internal/machines/registry.go's
// LogRegistrySnapshot makes the identical trade-off.
const debugLoggingOptionsFile = "/data/options.json"

// isDebugLoggingEnabled ports lib/data.js's isDebugLoggingEnabled() /
// loadOptions().debug_logging — off by default, falling back to
// GLP_DEBUG_LOGGING (#764, standalone Docker) when options.json is missing
// or doesn't parse.
func isDebugLoggingEnabled() bool {
	data, err := os.ReadFile(debugLoggingOptionsFile)
	if err != nil {
		return os.Getenv("GLP_DEBUG_LOGGING") == "true"
	}
	var opts struct {
		DebugLogging bool `json:"debug_logging"`
	}
	if err := json.Unmarshal(data, &opts); err != nil {
		return os.Getenv("GLP_DEBUG_LOGGING") == "true"
	}
	return opts.DebugLogging
}

// debugLogf ports lib/data.js's debugLog(message) — a "[debug]"-prefixed
// log line, gated on isDebugLoggingEnabled().
func debugLogf(format string, args ...any) {
	if isDebugLoggingEnabled() {
		log.Printf("[debug] "+format, args...)
	}
}
