package orders

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newTestHandlers opens a throwaway on-disk SQLite DB (same fixture
// pattern as shots/library's own helpers_test.go) and wires it into a
// fresh orders Handlers, plus every cross-domain repository it needs.
// Also sets GLP_ENABLE_ORDERS=true and clears any real /data/options.json
// interference — see options.go's isOrdersEnabled() — so every handler
// test below runs with the orders feature on unless a test explicitly
// unsets it.
func newTestHandlers(t *testing.T) (*Handlers, *Repository, *sql.DB) {
	t.Helper()
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv() // no SUPERVISOR_TOKEN/GLP_HA_URL in test env -> disabled, no real HTTP calls

	h := NewHandlers(repo, shotsRepo, libRepo, registry, haClient)
	return h, repo, sqlDB
}

func newMux(h *Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func doJSON(t *testing.T, mux *http.ServeMux, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

func decodeBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response body %q: %v", body, err)
	}
	return m
}

func decodeBodyArray(t *testing.T, body []byte) []map[string]any {
	t.Helper()
	var m []map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response array %q: %v", body, err)
	}
	return m
}

// httpNewJSONRequest builds a request like doJSON but returns it
// unserved, so a test can set extra headers (e.g. X-GLP-HA-User-ID)
// before calling httptestRecord.
func httpNewJSONRequest(t *testing.T, method, path string, body []byte) *http.Request {
	t.Helper()
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	return r
}

func httptestRecord(mux *http.ServeMux, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
