package webapp

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeModelFile(t *testing.T, dir, name string, body []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestModelHandlers_ServesFiles(t *testing.T) {
	dir := t.TempDir()
	writeModelFile(t, dir, "a.onnx", []byte("onnx-bytes"))
	writeModelFile(t, dir, "b.wasm", []byte("wasm-bytes"))

	mux := http.NewServeMux()
	NewModelHandlers(dir).RegisterRoutes(mux)

	cases := []struct {
		path     string
		wantCT   string
		wantBody string
	}{
		{"/models/a.onnx", "application/octet-stream", "onnx-bytes"},
		{"/models/b.wasm", "application/wasm", "wasm-bytes"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status = %d, want 200", tc.path, rec.Code)
			continue
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, tc.wantCT) {
			t.Errorf("GET %s: Content-Type = %q, want prefix %q", tc.path, ct, tc.wantCT)
		}
		if got := rec.Header().Get("Cache-Control"); got != "public, max-age=604800" {
			t.Errorf("GET %s: Cache-Control = %q", tc.path, got)
		}
		if got := rec.Body.String(); got != tc.wantBody {
			t.Errorf("GET %s: body = %q, want %q", tc.path, got, tc.wantBody)
		}
	}
}

func TestModelHandlers_Head(t *testing.T) {
	dir := t.TempDir()
	writeModelFile(t, dir, "a.onnx", []byte("onnx-bytes"))

	mux := http.NewServeMux()
	NewModelHandlers(dir).RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/models/a.onnx", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD /models/a.onnx: status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD /models/a.onnx: body = %q, want empty", rec.Body.String())
	}
}

func TestModelHandlers_NotFound(t *testing.T) {
	dir := t.TempDir()
	writeModelFile(t, dir, "a.onnx", []byte("onnx-bytes"))
	writeModelFile(t, dir, ".hidden", []byte("secret"))

	mux := http.NewServeMux()
	NewModelHandlers(dir).RegisterRoutes(mux)

	for _, target := range []string{
		"/models/missing.onnx",
		"/models/..%2Fx",
		"/models/.hidden",
	} {
		t.Run(target, func(t *testing.T) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
			if rec.Code != http.StatusNotFound {
				t.Errorf("GET %s: status = %d, want 404", target, rec.Code)
			}
		})
	}
}

func TestModelHandlers_DisabledWhenDirEmpty(t *testing.T) {
	mux := http.NewServeMux()
	NewModelHandlers("").RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/models/a.onnx", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("empty dir: status = %d, want 404", rec.Code)
	}
}

// TestModelHandlers_OutranksStaticCatchAll proves the more specific
// /models/{file} pattern wins over the SPA's method-less "/" catch-all rather
// than being shadowed by it.
func TestModelHandlers_OutranksStaticCatchAll(t *testing.T) {
	dir := t.TempDir()
	writeModelFile(t, dir, "a.onnx", []byte("onnx-bytes"))

	mux := http.NewServeMux()
	testHandlers(t).RegisterRoutes(mux)
	NewModelHandlers(dir).RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/models/a.onnx", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "onnx-bytes" {
		t.Fatalf("GET /models/a.onnx hit the SPA handler, not the model handler: status=%d body=%q", rec.Code, rec.Body.String())
	}

	// Non-model paths still reach the SPA static handler.
	spa := httptest.NewRecorder()
	mux.ServeHTTP(spa, httptest.NewRequest(http.MethodGet, "/manifest.json", nil))
	if spa.Code != http.StatusOK {
		t.Errorf("GET /manifest.json: status = %d, want 200", spa.Code)
	}
}
