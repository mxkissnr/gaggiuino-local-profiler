package shots

import (
	"net/http"

	json "github.com/goccy/go-json"
)

// goccy/go-json replaces reflect-based encoding/json for this package's own
// (un)marshalling. /shots.json hydrates and then re-serialises every shot's
// full datapoints payload on every request (213 shots, ~2 MB of nested
// number arrays); goccy marshals and unmarshals that materially faster
// (#951). It is API-compatible with encoding/json for everything this
// package relies on — struct tags, HTML escaping, and verbatim passthrough
// of encoding/json.RawMessage (hydrateRow's datapoints projection and
// DatapointsMap both depend on the last one).
//
// The datapoints value stays an encoding/json.RawMessage (not goccy's own
// RawMessage type) so the packages that marshal a hydrated shot through
// plain encoding/json — internal/backup's export, internal/web's views —
// keep emitting it as raw JSON rather than a base64 []byte.

// writeJSON is the package-local counterpart of httputil.WriteJSON: same
// contract (Content-Type, generic 500 body on a marshal failure), goccy
// encoder. Every internal/shots handler writes its response through this.
func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"Internal server error"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// writeError writes {"error": message} at status — httputil.WriteError's
// package-local counterpart.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
