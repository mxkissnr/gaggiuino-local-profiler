// Package httputil holds the tiny JSON-response helpers every REST domain
// package (orders, backup, maintenance, machines, shots, library, system)
// had copy-pasted verbatim across Phases 1c-1g — WriteJSON/WriteError were
// byte-for-byte identical in all seven handlers.go files, and InternalError
// differed only in whether/how it logged (orders and system domain-prefixed
// their log line, backup/maintenance/machines/library either swallowed the
// error silently or discarded it with a `_ = err` comment solely to satisfy
// the compiler). Extracted per the Phase 1g code-review's finding #5 (#901):
// one implementation, every domain package's own internalError now a
// one-line wrapper passing its own domain prefix.
package httputil

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
)

// WriteJSON marshals v as the response body at status. A marshal failure
// (a caller passing an unmarshalable value, which should never happen for
// any of this codebase's own response types) degrades to a hardcoded 500
// body rather than a panic or a half-written response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"Internal server error"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}

// WriteError writes {"error": message} at status.
func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]string{"error": message})
}

// InternalError logs err with domain's prefix (matching this codebase's
// "<package>: <what>: %v" log convention) and writes the generic 500 body —
// never the raw error text, which could leak internal details (file paths,
// SQL, a machine host) to the client.
func InternalError(w http.ResponseWriter, domain string, err error) {
	log.Printf("%s: internal error: %v", domain, err)
	WriteError(w, http.StatusInternalServerError, "Internal server error")
}

// DecodeJSONBody decodes r's body (capped at limit bytes) into a value of
// type T, tolerating a genuinely empty body (io.EOF) as T's zero value
// instead of an error — matching Express's own req.body defaulting to {}
// for a bodyless request under server.js's global express.json() middleware.
// A non-empty but malformed body still writes 400 "Invalid JSON body"; an
// oversized body writes 413 "request entity too large". This was
// independently duplicated (byte-for-byte except for the EOF handling) in
// every domain package's own decodeJSONBody(w, r) (map[string]any, bool) —
// library, machines (see DecodeJSONBodyInto below for its pointer variant),
// orders, shots, system, maintenance — until #901's Phase 3b code review
// found the same latent "empty body 400s" bug (already fixed once for
// maintenance's POST /api/maintenance/{task}/done, see that commit) waiting
// to bite every other domain's optional-body endpoint. Callers whose
// endpoint requires specific fields get no free validation from this —
// same as Node, where express.json() never enforces required fields either
// — so each such call site must keep checking for its own required fields
// after a successful decode (see e.g. internal/library's "name required"
// checks); decodeJSONBody returning {} on an empty body doesn't change that.
func DecodeJSONBody[T any](w http.ResponseWriter, r *http.Request, limit int64) (T, bool) {
	var body T
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return body, true
		}
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			WriteError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		} else {
			WriteError(w, http.StatusBadRequest, "Invalid JSON body")
		}
		var zero T
		return zero, false
	}
	return body, true
}

// DecodeJSONBodyInto is DecodeJSONBody's pointer-target counterpart, for
// callers that pre-populate v with defaults before decoding (internal/machines'
// decodeJSONBody(w, r, v) callers construct a struct literal with its own
// zero-value-but-meaningful defaults, then decode into &that — a fresh T
// returned by value, as DecodeJSONBody does, would discard those defaults).
// Already tolerated a genuinely empty body as "v keeps its defaults" before
// this extraction (internal/machines never had the #901 empty-body bug);
// unified here purely to remove the duplication, behavior unchanged.
func DecodeJSONBodyInto(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			WriteError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		} else {
			WriteError(w, http.StatusBadRequest, "Invalid JSON body")
		}
		return false
	}
	return true
}

// ValidationError carries a caller-facing 400 message — the same
// status-carrying-error convention internal/orders.OrderError established
// for that package, generalized here (#901 code review finding #5) since
// internal/library and internal/machines each independently defined an
// identical `type ValidationError struct{ Message string }` in their own
// create.go for their Create*/CreateMachineChecked functions to signal
// "reject with 400 and this message" to their web and REST callers alike.
// Both packages now alias this type (`type ValidationError =
// httputil.ValidationError`) instead of redeclaring it, so every existing
// `*library.ValidationError`/`*machines.ValidationError` call site — and
// the bare `*ValidationError` used within each package — keeps working
// unchanged.
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

// SafeCall runs fn synchronously, recovering any panic instead of letting
// it propagate (#993), and reports whether one occurred so the caller can
// treat a recovered panic as an error condition instead of silently
// proceeding on fn's zero-value output (#994 review: the first cut of this
// only logged, so a WaitGroup-bound caller like firmwareVersion's/
// settingsPage's concurrent fetches had no way to tell a recovered panic
// apart from a clean, empty result). This add-on has no supervised-restart
// design, so an unrecovered panic anywhere reachable from a background
// goroutine or a request-spawned helper goroutine (machine-adapter
// parsing, a scheduled sync tick, a WaitGroup-bound fan-out fetch, ...)
// takes the whole process down -- a panic inside the request-handling
// goroutine itself doesn't need this (net/http's own per-connection
// recover already contains it), but recover() never crosses a goroutine
// boundary, so anything spawned with a bare `go` -- fire-and-forget or
// awaited via sync.WaitGroup -- is on its own. logCtx prefixes the
// recovered panic's log line, matching this codebase's
// "<package>: <what>: %v" convention.
func SafeCall(logCtx string, fn func()) (recovered bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("%s: panic recovered: %v", logCtx, r)
			recovered = true
		}
	}()
	fn()
	return false
}

// SafeGo runs fn in a new goroutine via SafeCall, so a panic inside it logs
// and unwinds instead of crashing the process. Use for background/
// fire-and-forget goroutines (a ticker loop, a periodic sync, a persistent
// live-machine WS session, a post-response notification); use SafeCall
// directly (no new goroutine) for a goroutine already spawned by the
// caller, e.g. one signaling completion via a WaitGroup.
func SafeGo(logCtx string, fn func()) {
	go SafeCall(logCtx, fn)
}
