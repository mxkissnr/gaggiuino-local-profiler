package backup

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newTestHandlers wires a full set of throwaway repositories (one SQLite
// DB, same fixture pattern every other domain package's tests already
// use) into backup Handlers. Image reads/writes go through imageDir
// (library.DefaultImageDir, "/data/bean-images") unconditionally — no test
// here uploads/restores an image, so that directory is never touched
// (os.ReadDir failing silently on a nonexistent /data is already
// gatherBackupData's own best-effort branch).
func newTestHandlers(t *testing.T) (*Handlers, Dependencies, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	libRepo := library.NewRepository(sqlDB)
	deps := Dependencies{
		DB:              sqlDB,
		ShotsRepo:       shots.NewRepository(sqlDB),
		LibRepo:         libRepo,
		OrdersRepo:      orders.NewRepository(sqlDB),
		MaintenanceRepo: maintenance.NewRepository(sqlDB, libRepo),
		Registry:        machines.NewRegistry(sqlDB),
		Token:           "test-token-value",
		TokenFile:       filepath.Join(t.TempDir(), "api_token.txt"),
	}
	h := NewHandlers(deps)
	return h, deps, sqlDB
}

func newMux(h *Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func doJSON(t *testing.T, mux *http.ServeMux, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, nil)
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

// doZip POSTs raw zip bytes to path as application/zip (the frontend's
// real restore upload shape).
func doZip(t *testing.T, mux *http.ServeMux, path string, zipBytes []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(zipBytes))
	r.Header.Set("Content-Type", "application/zip")
	for k, v := range headers {
		r.Header.Set(k, v)
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

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
