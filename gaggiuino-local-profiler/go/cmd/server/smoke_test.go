package main

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This file is the HA-ingress smoke test (#901, Phase 3). It boots the
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
	dir := t.TempDir()
	cfg := appConfig{
		dbPath:          filepath.Join(dir, "glp.db"),
		tokenPath:       filepath.Join(dir, "api_token.txt"),
		port:            "0",
		rateLimitWindow: time.Minute,
		rateLimitMax:    1_000_000, // this test fires ~10 requests; never rate-limit them
	}
	ctx, cancel := context.WithCancel(context.Background())
	handler, sqlDB, err := buildApp(ctx, cfg)
	if err != nil {
		cancel()
		t.Fatalf("buildApp: %v", err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		srv.Close()
		cancel()
		sqlDB.Close()
	})

	raw, err := os.ReadFile(cfg.tokenPath)
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

	// The bare /ui/ entrypoint must redirect with a RELATIVE Location, so
	// the browser resolves it against its ingress address bar
	// (/api/hassio_ingress/<tok>/ui/), not the origin root.
	resp := smokeGet(t, base+"/ui/", map[string]string{"X-Ingress-Path": ingressHeader})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("GET /ui/ status = %d, want 302", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); strings.HasPrefix(loc, "/") || loc == "" {
		t.Errorf("GET /ui/ Location = %q, want a relative target (no leading slash)", loc)
	}

	// The SPA shell and every templ page must reference their assets/links
	// relatively — a leading-slash href/src/action/hx-* breaks the moment
	// the app is served under /api/hassio_ingress/<tok>/.
	for _, path := range []string{"/", "/ui/shots"} {
		resp := smokeGet(t, base+path, map[string]string{
			"X-Ingress-Path": ingressHeader,
			"X-GLP-Token":    token,
		})
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", path, resp.StatusCode)
		}
		for _, needle := range []string{`href="/`, `src="/`, `action="/`, `hx-get="/`, `hx-post="/`} {
			if strings.Contains(string(body), needle) {
				t.Errorf("GET %s response contains origin-absolute reference %q — breaks under an ingress prefix", path, needle)
			}
		}
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
