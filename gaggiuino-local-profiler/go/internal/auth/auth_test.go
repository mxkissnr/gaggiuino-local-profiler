package auth

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Not a secret -- a plain fixture string. IsTokenValid does a byte-for-byte
// compare with no hex-decoding requirement, so RequireToken's tests below
// need no particular length or charset, just a stand-in value distinct from
// TestIsTokenValid's own "real" fixture above.
const testToken = "test-fixture-token-not-a-real-secret"

func newAuthedHandler() http.Handler {
	return RequireToken(testToken)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func TestRequireToken_ValidHeaderPasses(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/shots", nil)
	req.RemoteAddr = "192.168.1.50:1234" // not Supervisor -> Ingress bypass doesn't apply
	req.Header.Set("X-GLP-Token", testToken)
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestRequireToken_MissingTokenRejected(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/shots", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json content type, got %q", ct)
	}
	if body := rec.Body.String(); body != `{"error":"Unauthorized"}` {
		t.Errorf("unexpected body: %q", body)
	}
}

func TestRequireToken_SSEQueryParamFallback(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/events?token="+testToken, nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestRequireToken_QueryParamFallbackOnlyAppliesToEvents(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/shots?token="+testToken, nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 (query-param fallback must not apply outside /api/events), got %d", rec.Code)
	}
}

func TestRequireToken_IngressBypass(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/shots", nil)
	req.RemoteAddr = "172.30.1.5:1234"
	req.Header.Set("X-Ingress-Path", "/api/hassio_ingress/abc123")
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected genuine Ingress request to bypass auth, got %d", rec.Code)
	}
}

func TestRequireToken_SpoofedIngressHeaderFromLANRejected(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/shots", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	req.Header.Set("X-Ingress-Path", "/api/hassio_ingress/abc123")
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected spoofed Ingress header from a LAN client to be rejected, got %d", rec.Code)
	}
}

func TestRequireToken_StatusAndTokenEndpointsBypassAuth(t *testing.T) {
	for _, path := range []string{"/api/status", "/api/token"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "192.168.1.50:1234"
		rec := httptest.NewRecorder()
		newAuthedHandler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: expected 200 without a token, got %d", path, rec.Code)
		}
	}
}

func TestRequireToken_NonAPIPathBypassesAuth(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for a non-/api/ path without a token, got %d", rec.Code)
	}
}

// TestRequireToken_NonAPIWritePathRequiresAuth pins the #901 code-review
// fix: the non-/api/ bypass must not swallow write methods. Before the
// fix, any POST/PUT/DELETE to a path outside /api/ (e.g. the htmx write
// actions internal/web registers at /shots/{id}/trash) sailed through
// unauthenticated — a CSRF hole, since no token/custom header was needed.
func TestRequireToken_NonAPIWritePathRequiresAuth(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		req := httptest.NewRequest(method, "/shots/1/trash", nil)
		req.RemoteAddr = "192.168.1.50:1234"
		rec := httptest.NewRecorder()
		newAuthedHandler().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s /shots/1/trash without a token: status = %d, want 401", method, rec.Code)
		}
	}
}

// TestRequireToken_NonAPIWritePathWithTokenPasses is the flip side: a
// write to a non-/api/ path DOES pass once a valid X-GLP-Token is
// attached, the same way the JSON API already works.
func TestRequireToken_NonAPIWritePathWithTokenPasses(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/shots/1/trash", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	req.Header.Set("X-GLP-Token", testToken)
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /shots/1/trash with a valid token: status = %d, want 200", rec.Code)
	}
}

// TestRequireToken_NonAPIWritePathIngressBypass confirms genuine Ingress
// requests still bypass auth for write methods too — IsIngressRequest is
// checked ahead of (and independently of) the GET/HEAD-scoped bypass, so
// the add-on's primary access path is unaffected by this fix.
func TestRequireToken_NonAPIWritePathIngressBypass(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/shots/1/trash", nil)
	req.RemoteAddr = "172.30.1.5:1234"
	req.Header.Set("X-Ingress-Path", "/api/hassio_ingress/abc123")
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /shots/1/trash via genuine Ingress: status = %d, want 200", rec.Code)
	}
}

// TestRequireToken_HeadRequestBypassesAuth verifies HEAD gets the same
// bypass as GET — net/http.ServeMux itself routes HEAD to a "GET ..."
// registered pattern, so the two need identical auth treatment.
func TestRequireToken_HeadRequestBypassesAuth(t *testing.T) {
	req := httptest.NewRequest(http.MethodHead, "/shots", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD /shots without a token: status = %d, want 200", rec.Code)
	}
}

func TestRequireToken_ShotsJSONRequiresAuth(t *testing.T) {
	// Explicit carve-out in server.js: /shots.json is the one non-/api/
	// path that still requires a token.
	req := httptest.NewRequest(http.MethodGet, "/shots.json", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	newAuthedHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for /shots.json without a token, got %d", rec.Code)
	}
}

func TestRequireToken_EmptyTokenFailsClosed(t *testing.T) {
	handler := RequireToken("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not run when no token is configured")
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

func TestIsSupervisorIP(t *testing.T) {
	cases := []struct {
		name string
		ip   string
		want bool
	}{
		{"loopback v4", "127.0.0.1", true},
		{"loopback v6", "::1", true},
		{"loopback v4-mapped-v6", "::ffff:127.0.0.1", true},
		{"loopback block but not exactly 127.0.0.1", "127.0.0.5", false},
		{"loopback block but not exactly 127.0.0.1 (2)", "127.9.9.9", false},
		{"supervisor net start", "172.30.0.0", true},
		{"supervisor net middle", "172.30.55.12", true},
		{"supervisor net end", "172.30.255.255", true},
		{"supervisor net v4-mapped-v6", "::ffff:172.30.1.2", true},
		{"just outside supervisor net (next /16)", "172.31.0.1", false},
		{"just outside supervisor net (prev /16)", "172.29.255.255", false},
		{"unrelated private range", "10.0.0.1", false},
		{"unrelated public IP", "8.8.8.8", false},
		{"empty string", "", false},
		{"garbage", "not-an-ip", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsSupervisorIP(c.ip); got != c.want {
				t.Errorf("IsSupervisorIP(%q) = %v, want %v", c.ip, got, c.want)
			}
		})
	}
}

func newRequest(remoteAddr, ingressPath string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	r.RemoteAddr = remoteAddr
	if ingressPath != "" {
		r.Header.Set("X-Ingress-Path", ingressPath)
	}
	return r
}

func TestIsFromSupervisor(t *testing.T) {
	if !IsFromSupervisor(newRequest("172.30.1.5:54321", "")) {
		t.Error("expected supervisor-network RemoteAddr to be trusted")
	}
	if IsFromSupervisor(newRequest("192.168.1.50:54321", "")) {
		t.Error("expected LAN RemoteAddr to not be trusted")
	}
	// RemoteAddr without a port (some test harnesses / fabricated requests)
	// must still be parsed correctly.
	if !IsFromSupervisor(newRequest("172.30.1.5", "")) {
		t.Error("expected bare supervisor IP (no port) to be trusted")
	}
}

func TestIsIngressRequest(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		ingress    string
		want       bool
	}{
		{"genuine ingress", "172.30.1.5:1234", "/api/hassio_ingress/abc123", true},
		{"supervisor IP, no ingress header", "172.30.1.5:1234", "", false},
		{"supervisor IP, wrong prefix", "172.30.1.5:1234", "/not/the/right/prefix", false},
		{"spoofed header from LAN client", "192.168.1.50:1234", "/api/hassio_ingress/abc123", false},
		{"spoofed header from arbitrary WAN IP", "8.8.8.8:1234", "/api/hassio_ingress/abc123", false},
		{"prefix substring but not real prefix", "172.30.1.5:1234", "/api/hassio_ingress", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRequest(c.remoteAddr, c.ingress)
			if got := IsIngressRequest(r); got != c.want {
				t.Errorf("IsIngressRequest() = %v, want %v", got, c.want)
			}
		})
	}
}

func TestIsTokenValid(t *testing.T) {
	const real = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"

	if !IsTokenValid(real, real) {
		t.Error("expected exact match to be valid")
	}
	if IsTokenValid(real, "") {
		t.Error("expected empty candidate to be invalid")
	}
	if IsTokenValid("", real) {
		t.Error("expected empty stored token to be invalid")
	}
	if IsTokenValid("", "") {
		t.Error("expected two empty strings to be invalid")
	}
	if IsTokenValid(real, real[:len(real)-1]) {
		t.Error("expected a shorter candidate to be invalid")
	}
	if IsTokenValid(real, real+"x") {
		t.Error("expected a longer candidate to be invalid")
	}

	// Functional constant-time check: several different wrong tokens (same
	// length as the real one, differing at different positions — start,
	// middle, end) must all be uniformly rejected. This can't assert
	// anything about actual timing from a unit test, but it does pin the
	// behavior a broken early-exit implementation (e.g. reintroducing
	// strings.Compare or a byte-by-byte loop that returns as soon as it
	// finds a mismatch) would still get right functionally, so it at least
	// guards against IsTokenValid stopping being constant *and* correct at
	// the same time going undetected.
	wrongTokens := []string{
		"x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
		"0123456789abcdef0123456789abcXef0123456789abcdef0123456789abcd",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcX",
	}
	for _, wrong := range wrongTokens {
		if IsTokenValid(real, wrong) {
			t.Errorf("expected wrong token %q to be rejected", wrong)
		}
	}
}

func TestLoadOrCreateToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api_token.txt")

	token1, err := LoadOrCreateToken(path)
	if err != nil {
		t.Fatalf("LoadOrCreateToken (create): %v", err)
	}
	if len(token1) != 64 { // 32 random bytes, hex-encoded
		t.Fatalf("expected a 64-char hex token, got %d chars: %q", len(token1), token1)
	}
	if _, err := hex.DecodeString(token1); err != nil {
		t.Fatalf("generated token is not valid hex: %v", err)
	}

	token2, err := LoadOrCreateToken(path)
	if err != nil {
		t.Fatalf("LoadOrCreateToken (reload): %v", err)
	}
	if token1 != token2 {
		t.Fatalf("expected reloaded token to match generated token: %q != %q", token1, token2)
	}

	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("expected the .tmp file to be renamed away, stat err = %v", err)
	}
}

func TestLoadOrCreateToken_TrimsWhitespace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api_token.txt")
	if err := os.WriteFile(path, []byte("  some-token-value  \n"), 0o644); err != nil {
		t.Fatalf("seeding token file: %v", err)
	}
	token, err := LoadOrCreateToken(path)
	if err != nil {
		t.Fatalf("LoadOrCreateToken: %v", err)
	}
	if token != "some-token-value" {
		t.Fatalf("expected whitespace-trimmed token, got %q", token)
	}
}

func TestLoadOrCreateToken_UniqueAcrossFiles(t *testing.T) {
	dir := t.TempDir()
	t1, err := LoadOrCreateToken(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatalf("LoadOrCreateToken a: %v", err)
	}
	t2, err := LoadOrCreateToken(filepath.Join(dir, "b.txt"))
	if err != nil {
		t.Fatalf("LoadOrCreateToken b: %v", err)
	}
	if t1 == t2 {
		t.Fatal("expected independently generated tokens to differ")
	}
}

func TestSecurityHeaders(t *testing.T) {
	handler := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "SAMEORIGIN",
		"Referrer-Policy":        "same-origin",
		"Permissions-Policy":     "camera=(self), microphone=(), geolocation=()",
		"Content-Security-Policy": "default-src 'self'; " +
			"script-src 'self'; " +
			"style-src 'self' 'unsafe-inline'; " +
			"font-src 'self' data:; " +
			"img-src 'self' data: blob:; " +
			"connect-src 'self'; " +
			"frame-ancestors 'self';",
	}
	for header, expected := range want {
		if got := rec.Header().Get(header); got != expected {
			t.Errorf("header %s = %q, want %q", header, got, expected)
		}
	}
}

// sanity check that crypto/rand itself behaves as expected in this
// environment (guards against a sandboxed/broken entropy source silently
// making every generated token identical).
func TestCryptoRandSanity(t *testing.T) {
	a := make([]byte, 32)
	b := make([]byte, 32)
	if _, err := rand.Read(a); err != nil {
		t.Fatalf("rand.Read a: %v", err)
	}
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand.Read b: %v", err)
	}
	if hex.EncodeToString(a) == hex.EncodeToString(b) {
		t.Fatal("expected two independent random reads to differ")
	}
}
