package machines

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// newTestRegistry opens a throwaway on-disk SQLite DB via internal/db.Open,
// same fixture pattern as internal/shots/internal/library's own tests.
func newTestRegistry(t *testing.T) (*Registry, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return NewRegistry(sqlDB), sqlDB
}

// newTestHandlers builds a Handlers around a fresh throwaway registry and
// a real (unpublished) SSE hub, so Publish() calls from live.go have
// somewhere to go without panicking during a test.
func newTestHandlers(t *testing.T) (*Handlers, *Registry, *sql.DB) {
	t.Helper()
	registry, sqlDB := newTestRegistry(t)
	h := NewHandlers(registry, sse.NewHub())
	return h, registry, sqlDB
}

// newMux routes h's endpoints through a real *http.ServeMux — required for
// r.PathValue("id")/{category} to be populated, same as shots/library's
// own newMux helper.
func newMux(h *Handlers) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func decodeBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decoding response body %q: %v", body, err)
	}
	return m
}

// doRequest runs req through mux and returns the recorded response.
func doRequest(mux *http.ServeMux, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// allowLoopbackMachineHost disables the SSRF guard's loopback check for the
// duration of a test — every fake machine server in this package's test
// suite is an httptest.Server, which only ever binds to 127.0.0.1, an
// address assertMachineHost correctly rejects for a REAL machine host (see
// ssrf_test.go's own coverage of that behavior). This substitutes
// registry.go's machineHostGuard seam rather than weakening
// assertMachineHost itself. Also overrides machineHostGuardResolved
// (#987) — guardedDialContext (http.go) uses that seam to pin the actual
// dial, so a real connection to a fake httptest.Server would otherwise
// still get rejected there even with machineHostGuard itself stubbed out.
func allowLoopbackMachineHost(t *testing.T) {
	t.Helper()
	origGuard := machineHostGuard.set(func(ctx context.Context, hostname string) error { return nil })
	origResolved := machineHostGuardResolved.set(func(ctx context.Context, hostname string) (net.IP, error) {
		if ip := net.ParseIP(hostname); ip != nil {
			return ip, nil
		}
		return nil, fmt.Errorf("allowLoopbackMachineHost: unexpected non-IP hostname %q", hostname)
	})
	t.Cleanup(func() {
		machineHostGuard.set(origGuard)
		machineHostGuardResolved.set(origResolved)
	})
}
