// Package uiprefs stores per-install UI choices (view, filter, sort) so they
// follow the user across devices. The whole store is one JSON object under
// kv.key = 'ui_prefs'; which choices live here is the client's decision, the
// server only stores and validates them.
package uiprefs

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sync"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// Limits enforced by Sanitize. They bound what the client may keep
// server-side and keep the single kv row small.
const (
	// jsonBodyLimit is the PUT /api/ui-prefs body ceiling, matching the other
	// JSON domain handlers.
	jsonBodyLimit = 16 * 1024
	// maxKeys is the most top-level keys the object may carry.
	maxKeys = 64
	// maxFlatKeys is the most keys a single flat object value may carry.
	maxFlatKeys = 16
	// maxStringLen is the longest accepted string value.
	maxStringLen = 256
	// maxEncodedBytes is the ceiling on the encoded object's size.
	maxEncodedBytes = 16 * 1024
)

// keyRe is the key allow-list, applied to top-level keys and to the keys of a
// flat object value: a lowercase letter followed by up to 63 letters, digits,
// '.', '_' or '-'.
var keyRe = regexp.MustCompile(`^[a-z][a-zA-Z0-9._-]{0,63}$`)

// Repository is the kv-backed ui-prefs store.
type Repository struct{ db *sql.DB }

func NewRepository(db *sql.DB) *Repository { return &Repository{db: db} }

// Get returns the stored preferences. A missing row or malformed JSON reads
// as an empty object rather than an error — the store is a best-effort cache.
func (r *Repository) Get() (map[string]any, error) {
	var value string
	err := r.db.QueryRow(`SELECT value FROM kv WHERE key = 'ui_prefs'`).Scan(&value)
	if err == sql.ErrNoRows {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("uiprefs: reading ui prefs: %w", err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(value), &stored); err != nil || stored == nil {
		return map[string]any{}, nil
	}
	return stored, nil
}

// Save replaces the stored object. Callers pass a value Sanitize accepted —
// Save itself does no validation (mirrors shots.SaveShotDefaults).
func (r *Repository) Save(prefs map[string]any) error {
	b, err := json.Marshal(prefs)
	if err != nil {
		return fmt.Errorf("uiprefs: encoding ui prefs: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('ui_prefs', ?)`, string(b)); err != nil {
		return fmt.Errorf("uiprefs: saving ui prefs: %w", err)
	}
	return nil
}

// Sanitize validates and copies an untrusted preferences object, returning
// the cleaned map and a list of human-readable issues. An empty issue list
// means the whole object is acceptable; otherwise the PUT handler rejects it
// with 400 and the restore path leaves the current prefs untouched.
func Sanitize(in map[string]any) (map[string]any, []string) {
	out := map[string]any{}
	if len(in) > maxKeys {
		return out, []string{fmt.Sprintf("too many keys: %d (max %d)", len(in), maxKeys)}
	}
	var issues []string
	for k, v := range in {
		if !keyRe.MatchString(k) {
			issues = append(issues, fmt.Sprintf("invalid key %q", k))
			continue
		}
		cleaned, ok := sanitizeValue(v)
		if !ok {
			issues = append(issues, fmt.Sprintf("invalid value for key %q", k))
			continue
		}
		out[k] = cleaned
	}
	if len(issues) == 0 {
		b, err := json.Marshal(out)
		if err != nil {
			issues = append(issues, "preferences are not encodable as JSON")
		} else if len(b) > maxEncodedBytes {
			issues = append(issues, fmt.Sprintf("preferences exceed %d bytes when encoded", maxEncodedBytes))
		}
	}
	return out, issues
}

// sanitizeValue accepts a scalar, or a flat object of up to maxFlatKeys such
// scalars. Any deeper nesting (an object or array inside a flat object) is
// rejected.
func sanitizeValue(v any) (any, bool) {
	obj, ok := v.(map[string]any)
	if !ok {
		return sanitizeScalar(v)
	}
	if len(obj) > maxFlatKeys {
		return nil, false
	}
	flat := make(map[string]any, len(obj))
	for k, vv := range obj {
		if !keyRe.MatchString(k) {
			return nil, false
		}
		scalar, ok := sanitizeScalar(vv)
		if !ok {
			return nil, false
		}
		flat[k] = scalar
	}
	return flat, true
}

// sanitizeScalar accepts the scalar JSON values the store allows: null, a
// string of at most maxStringLen, a bool, or a number.
func sanitizeScalar(v any) (any, bool) {
	switch t := v.(type) {
	case nil:
		return nil, true
	case string:
		if len(t) > maxStringLen {
			return nil, false
		}
		return t, true
	case bool:
		return t, true
	case float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, json.Number:
		return v, true
	default:
		return nil, false
	}
}

// Handlers serves the ui-prefs REST routes.
type Handlers struct {
	repo *Repository
	// mu serialises the read-merge-write in put so two concurrent PUTs carrying
	// different keys cannot both read the old object and lose one update.
	mu sync.Mutex
}

func NewHandlers(repo *Repository) *Handlers { return &Handlers{repo: repo} }

// RegisterRoutes wires GET/PUT /api/ui-prefs onto mux; they run behind the
// same middleware chain as every other /api route (see cmd/server/main.go).
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ui-prefs", h.get)
	mux.HandleFunc("PUT /api/ui-prefs", h.put)
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) {
	prefs, err := h.repo.Get()
	if err != nil {
		httputil.InternalError(w, "uiprefs", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, prefs)
}

// put is a partial update: the body is merged into the stored object and a null
// value deletes its key. Only the keys the caller actually sent are validated
// for the 400 response; a stored value that no longer passes Sanitize is dropped
// silently from the result instead of rejecting the whole merge, so one stale
// key cannot block every later PUT. The response is the full stored object.
//
// The read-merge-write runs under h.mu: the app is a single process over one
// SQLite file, and without the lock two requests carrying different keys could
// both read the old object and the later save would drop the other's key.
func (h *Handlers) put(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	// Issues here are the caller's to fix, because they name keys it just sent.
	if _, issues := Sanitize(body); len(issues) > 0 {
		httputil.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "Validation failed", "issues": issues})
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	stored, err := h.repo.Get()
	if err != nil {
		httputil.InternalError(w, "uiprefs", err)
		return
	}
	merged := make(map[string]any, len(stored)+len(body))
	for k, v := range stored {
		merged[k] = v
	}
	for k, v := range body {
		if v == nil {
			delete(merged, k)
			continue
		}
		merged[k] = v
	}
	// Drop stored entries that no longer validate instead of rejecting: the
	// caller can only fix the keys it sent, not an old one it never touched.
	for k, v := range merged {
		if !keyRe.MatchString(k) {
			delete(merged, k)
			continue
		}
		cleanedValue, ok := sanitizeValue(v)
		if !ok {
			delete(merged, k)
			continue
		}
		merged[k] = cleanedValue
	}
	cleaned, issues := Sanitize(merged)
	if len(issues) > 0 {
		httputil.WriteJSON(w, http.StatusBadRequest, map[string]any{"error": "Validation failed", "issues": issues})
		return
	}
	if err := h.repo.Save(cleaned); err != nil {
		httputil.InternalError(w, "uiprefs", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, cleaned)
}

// decodeJSONBody mirrors the other domain packages: an empty body decodes to
// {}, an oversized one to 413, any other parse failure to 400.
func decodeJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, jsonBodyLimit)
	if !ok {
		return nil, false
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, true
}
