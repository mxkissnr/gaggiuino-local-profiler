package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegisterKioskRoute_ServesPageWithoutCaching(t *testing.T) {
	mux := http.NewServeMux()
	RegisterKioskRoute(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/kiosk", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /kiosk = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if !strings.Contains(rec.Body.String(), "kiosk.js") {
		t.Error("kiosk page does not reference kiosk.js")
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/kiosk", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /kiosk = %d, want 405", rec.Code)
	}
}
