package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

// TestBackupPage_RendersDownloadLinkAndRestoreNote verifies GET /backup's
// structural content: a link to the existing GET /api/backup export, and
// an explicit note that restore isn't built into this page — see
// handlers_backup.go's own doc comment for why that's a deliberate scope
// cut, not an oversight.
func TestBackupPage_RendersDownloadLinkAndRestoreNote(t *testing.T) {
	h := NewBackupHandlers()
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	rec := doRequest(t, mux, "GET", "/backup")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /backup: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`href="api/backup"`,
		"POST /api/restore",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /backup body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

// TestBackupPage_NoWriteRoutesRegistered pins that this page registers only
// the one read-only GET — no htmx write action exists here to gate behind
// auth.RequireToken (see handlers_backup.go's doc comment on why restore
// upload is out of this phase's scope). A stray POST to this page's own
// path must 405 (Go 1.22+ ServeMux's own "method not allowed" for a
// pattern registered under a different method) even WITH a valid token —
// proving there is no accidental write action hiding here, not just that
// an unauthenticated one is blocked.
func TestBackupPage_NoWriteRoutesRegistered(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"

	h := NewBackupHandlers()
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	handler := auth.RequireToken(testToken)(mux)

	req := httptest.NewRequest(http.MethodPost, "/backup", nil)
	req.RemoteAddr = "192.168.1.50:1234" // LAN, not Ingress/Supervisor
	req.Header.Set("X-GLP-Token", testToken)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /backup with a valid token: status = %d, want 405 (no write route registered)", rec.Code)
	}
}
