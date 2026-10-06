package main

import (
	"bufio"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This file is the HA-ingress smoke test (#901). It boots the
// real handler chain (buildApp: SecurityHeaders -> rate limiter ->
// RequireToken -> the full domain mux, exactly what main() serves) and
// drives the three ingress traps that hit the templ branch three times
// historically:
//
//	(a) path-prefix handling — a request arriving under an HA ingress base
//	    path must never be answered with an origin-absolute redirect/link
//	    that escapes that prefix. GLP's answer is "every internal reference
//	    is relative", so the trap is any leading-slash href/src/Location.
//	(b) SSE (/api/events) must not be buffered — it sets
//	    X-Accel-Buffering: no + Cache-Control: no-cache, no-transform and
//	    flushes the padding comment before the first event.
//	(c) token/auth behind the ingress header — a genuine ingress request
//	    (Supervisor-network source IP + X-Ingress-Path) bypasses the token,
//	    the same request without the header does not.
//
// httptest.NewServer listens on loopback, and auth.IsSupervisorIP trusts
// 127.0.0.1/::1 — so adding the X-Ingress-Path header to a request here is
// a genuine ingress request as far as auth.IsIngressRequest (auth.go:~227,
// reused, not reinvented) is concerned. The spoofed-header-from-a-LAN-IP
// rejection can't be reached over loopback and is covered by
// internal/auth/auth_test.go's TestRequireToken_SpoofedIngressHeaderFromLANRejected.

const ingressHeader = "/api/hassio_ingress/0123456789abcdef0123456789abcdef"

func newSmokeServer(t *testing.T) (base string, token string) {
	t.Helper()
	handler, _, dir := newTestApp(t, appConfig{
		port:            "0",
		rateLimitWindow: time.Minute,
		rateLimitMax:    1_000_000, // this test fires ~10 requests; never rate-limit them
	})
	srv := httptest.NewServer(handler)
	// Registered after newTestApp's cleanup, so on teardown it runs first (LIFO):
	// the HTTP server stops before the data directory is removed.
	t.Cleanup(srv.Close)

	raw, err := os.ReadFile(filepath.Join(dir, "api_token.txt"))
	if err != nil {
		t.Fatalf("reading generated token file: %v", err)
	}
	return srv.URL, strings.TrimSpace(string(raw))
}

func smokeGet(t *testing.T, url string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("building request for %s: %v", url, err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	// Don't follow redirects — trap (a) asserts on the Location header.
	client := &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

// ── trap (a): path-prefix handling under an ingress base path ──────────

func TestIngressSmoke_NoOriginAbsoluteReferences(t *testing.T) {
	base, token := newSmokeServer(t)

	// The old /ui/kiosk bookmark must keep working (#1267): 302 with a
	// genuinely relative Location onto the rebuilt kiosk page.
	respKiosk := smokeGet(t, base+"/ui/kiosk", map[string]string{"X-Ingress-Path": ingressHeader})
	defer respKiosk.Body.Close()
	if respKiosk.StatusCode != http.StatusFound {
		t.Fatalf("GET /ui/kiosk status = %d, want 302", respKiosk.StatusCode)
	}
	if loc := respKiosk.Header.Get("Location"); strings.HasPrefix(loc, "/") || loc == "" {
		t.Errorf("GET /ui/kiosk Location = %q, want a relative target (no leading slash)", loc)
	}

	// #1200: the frozen templ pages that used to live under /ui/ are gone —
	// a path that used to be one now 404s (the SPA has no index.html
	// fallback for unknown paths).
	respGone := smokeGet(t, base+"/ui/shots", map[string]string{"X-GLP-Token": token})
	respGone.Body.Close()
	if respGone.StatusCode != http.StatusNotFound {
		t.Errorf("GET /ui/shots status = %d, want 404 (templ pages removed)", respGone.StatusCode)
	}

	// The SPA shell must reference its assets/links relatively — a
	// leading-slash href/src/action/hx-* breaks the moment the app is served
	// under /api/hassio_ingress/<tok>/.
	resp := smokeGet(t, base+"/", map[string]string{
		"X-Ingress-Path": ingressHeader,
		"X-GLP-Token":    token,
	})
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", resp.StatusCode)
	}
	for _, needle := range []string{`href="/`, `src="/`, `action="/`, `hx-get="/`, `hx-post="/`} {
		if strings.Contains(string(body), needle) {
			t.Errorf("GET / response contains origin-absolute reference %q — breaks under an ingress prefix", needle)
		}
	}

	// The rebuilt kiosk (#1267) is served at /kiosk.html by webapp's static
	// handler. A bare `go test` resolves the embed against the committed
	// dist/index.html placeholder (no frontend build), so the page only
	// exists in CI's frontend-built modes; when present it must be text/html,
	// and when absent it must still 404 cleanly rather than being claimed by
	// the removed /ui/ handlers.
	respKioskHTML := smokeGet(t, base+"/kiosk.html", map[string]string{"X-GLP-Token": token})
	respKioskHTML.Body.Close()
	switch respKioskHTML.StatusCode {
	case http.StatusOK:
		if ct := respKioskHTML.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET /kiosk.html Content-Type = %q, want text/html", ct)
		}
	case http.StatusNotFound:
		// Committed dist/index.html placeholder only — expected without a
		// frontend build.
	default:
		t.Errorf("GET /kiosk.html status = %d, want 200 (built) or 404 (placeholder dist)", respKioskHTML.StatusCode)
	}
}

// TestIngressSmoke_PWAGatingFollowsIngressDetection pins the other half of
// trap (a): the index shell is templated by whether the request arrived
// through ingress (auth.IsIngressRequest). Under ingress the PWA manifest
// link is omitted (the add-on is framed in the HA panel); on a bare port
// it is injected.
func TestIngressSmoke_PWAGatingFollowsIngressDetection(t *testing.T) {
	base, _ := newSmokeServer(t)

	viaIngress := smokeGet(t, base+"/", map[string]string{"X-Ingress-Path": ingressHeader})
	ingBody, _ := io.ReadAll(viaIngress.Body)
	viaIngress.Body.Close()
	if strings.Contains(string(ingBody), `rel="manifest"`) {
		t.Errorf("index served through ingress must not carry the PWA manifest link")
	}

	direct := smokeGet(t, base+"/", nil)
	directBody, _ := io.ReadAll(direct.Body)
	direct.Body.Close()
	if !strings.Contains(string(directBody), `rel="manifest"`) {
		t.Errorf("index served on a bare port must carry the PWA manifest link")
	}
}

// ── trap (b): SSE must not be buffered ────────────────────────────────

func TestIngressSmoke_SSEEndpointNotBuffered(t *testing.T) {
	base, token := newSmokeServer(t)

	req, _ := http.NewRequest(http.MethodGet, base+"/api/events?token="+token, nil)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("GET /api/events: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/events status = %d, want 200", resp.StatusCode)
	}
	for header, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-cache, no-transform",
		"X-Accel-Buffering": "no",
	} {
		if got := resp.Header.Get(header); got != want {
			t.Errorf("/api/events %s = %q, want %q", header, got, want)
		}
	}

	// The padding comment + first primed event must arrive without waiting
	// for the stream to fill a buffer — read the first line under a tight
	// deadline. A buffering proxy/handler would stall here.
	type lineResult struct {
		line string
		err  error
	}
	ch := make(chan lineResult, 1)
	go func() {
		line, err := bufio.NewReader(resp.Body).ReadString('\n')
		ch <- lineResult{line, err}
	}()
	select {
	case got := <-ch:
		if got.err != nil {
			t.Fatalf("reading first SSE line: %v", got.err)
		}
		if !strings.HasPrefix(got.line, ":") {
			t.Errorf("first SSE line = %q, want the leading padding comment", got.line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the first SSE byte — stream appears buffered")
	}
}

// ── trap (c): token/auth flow behind the ingress header ───────────────

func TestIngressSmoke_AuthBehindIngressHeader(t *testing.T) {
	base, token := newSmokeServer(t)
	const apiPath = "/api/shots/last"

	// No token, no ingress header -> 401.
	noAuth := smokeGet(t, base+apiPath, nil)
	noAuth.Body.Close()
	if noAuth.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET %s unauthenticated: status = %d, want 401", apiPath, noAuth.StatusCode)
	}

	// Genuine ingress request (loopback source IP + X-Ingress-Path) -> the
	// token is bypassed, same as the real Supervisor proxy.
	viaIngress := smokeGet(t, base+apiPath, map[string]string{"X-Ingress-Path": ingressHeader})
	viaIngress.Body.Close()
	if viaIngress.StatusCode != http.StatusOK {
		t.Errorf("GET %s via ingress: status = %d, want 200", apiPath, viaIngress.StatusCode)
	}

	// A spoofed X-Ingress-Path with the wrong prefix is not trusted even
	// from a loopback source -> still needs the token.
	badPrefix := smokeGet(t, base+apiPath, map[string]string{"X-Ingress-Path": "/nope/not-ingress"})
	badPrefix.Body.Close()
	if badPrefix.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET %s with a non-ingress X-Ingress-Path: status = %d, want 401", apiPath, badPrefix.StatusCode)
	}

	// Explicit token, no ingress header -> 200.
	withToken := smokeGet(t, base+apiPath, map[string]string{"X-GLP-Token": token})
	withToken.Body.Close()
	if withToken.StatusCode != http.StatusOK {
		t.Errorf("GET %s with a valid token: status = %d, want 200", apiPath, withToken.StatusCode)
	}
}

// TestIngressSmoke_MCPSettingsRequireToken pins #1288's auth shape: the MCP
// settings API lives under /api/, so like every other route it needs the
// token. The MCP endpoint itself is now always mounted but disabled by
// default, so a token-holder gets a 404 (not a 401) from it.
func TestIngressSmoke_MCPSettingsRequireToken(t *testing.T) {
	base, token := newSmokeServer(t)
	const settingsPath = "/api/mcp/settings"

	noAuth := smokeGet(t, base+settingsPath, nil)
	noAuth.Body.Close()
	if noAuth.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET %s unauthenticated: status = %d, want 401", settingsPath, noAuth.StatusCode)
	}

	withToken := smokeGet(t, base+settingsPath, map[string]string{"X-GLP-Token": token})
	body, _ := io.ReadAll(withToken.Body)
	withToken.Body.Close()
	if withToken.StatusCode != http.StatusOK {
		t.Fatalf("GET %s with token: status = %d, want 200", settingsPath, withToken.StatusCode)
	}
	if !strings.Contains(string(body), "developerToolsAvailable") {
		t.Errorf("GET %s body = %s, want developerToolsAvailable", settingsPath, body)
	}

	disabled := smokeGet(t, base+"/api/mcp", map[string]string{"X-GLP-Token": token})
	disabled.Body.Close()
	if disabled.StatusCode != http.StatusNotFound {
		t.Errorf("GET /api/mcp with token while disabled: status = %d, want 404", disabled.StatusCode)
	}
}
