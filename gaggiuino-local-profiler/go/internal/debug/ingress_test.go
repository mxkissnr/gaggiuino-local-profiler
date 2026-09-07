package debug

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testIngressPath = "/api/hassio_ingress/0123456789abcdef0123456789abcdef"

func ingressMux(t *testing.T) *http.ServeMux {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "glp.db")
	sqlDB := openTestDB(t, dbPath)
	return newMux(NewHandlers(sqlDB, dbPath, nil))
}

// ingressRequest fabricates a request that auth.IsIngressRequest accepts:
// a Supervisor-network source IP plus the X-Ingress-Path header.
func ingressRequest(target string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.RemoteAddr = "172.30.32.1:41000"
	r.Header.Set("X-Ingress-Path", testIngressPath)
	return r
}

func TestIngress_JSONShape_IngressRequest(t *testing.T) {
	mux := ingressMux(t)

	rec := httptest.NewRecorder()
	req := ingressRequest("/api/debug/ingress?format=json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var got ingressReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal report: %v; body=%s", err, rec.Body.String())
	}

	if !got.IsIngressRequest {
		t.Error("is_ingress_request = false, want true for a Supervisor-IP + X-Ingress-Path request")
	}
	if !got.IsSupervisorIP {
		t.Error("is_supervisor_ip = false, want true")
	}
	if got.AuthResult != "ingress-bypass" {
		t.Errorf("auth_result = %q, want ingress-bypass", got.AuthResult)
	}
	if got.XIngressPath != testIngressPath {
		t.Errorf("x_ingress_path = %q, want %q", got.XIngressPath, testIngressPath)
	}
	if got.ComputedExternalBase != testIngressPath {
		t.Errorf("computed_external_base = %q, want %q", got.ComputedExternalBase, testIngressPath)
	}
	if got.URLPath != "/api/debug/ingress" {
		t.Errorf("url_path = %q, want /api/debug/ingress", got.URLPath)
	}
	if got.Verdicts.PathPrefix.Status != "ok" {
		t.Errorf("verdicts.path_prefix.status = %q, want ok (well-formed X-Ingress-Path)", got.Verdicts.PathPrefix.Status)
	}
	if got.Verdicts.TokenFlow.Status != "ok" {
		t.Errorf("verdicts.token_flow.status = %q, want ok", got.Verdicts.TokenFlow.Status)
	}
	if got.Verdicts.SSEBuffering.Status != "unknown" {
		t.Errorf("verdicts.sse_buffering.status = %q, want unknown", got.Verdicts.SSEBuffering.Status)
	}
	if !strings.Contains(got.SSEProbeHint, "/api/debug/ingress/sse-probe") {
		t.Errorf("sse_probe_hint = %q, want it to name the sse-probe endpoint", got.SSEProbeHint)
	}
}

func TestPathPrefixVerdict(t *testing.T) {
	cases := []struct {
		name, path, want string
	}{
		{"empty", "", "warn"},
		{"classic hex token", "/api/hassio_ingress/0123456789abcdef", "ok"},
		{"url-safe token (newer HA)", "/api/hassio_ingress/aB3-_xYz.9", "ok"},
		{"wrong prefix", "/app/373fc166_glp_go_preview", "warn"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pathPrefixVerdict(c.path).Status; got != c.want {
				t.Errorf("pathPrefixVerdict(%q).Status = %q, want %q", c.path, got, c.want)
			}
		})
	}
}

func TestIngress_JSONShape_BareRequest(t *testing.T) {
	mux := ingressMux(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/debug/ingress", nil)
	req.Header.Set("Accept", "application/json")
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}

	var got ingressReport
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal report: %v", err)
	}

	if got.IsIngressRequest {
		t.Error("is_ingress_request = true, want false for a bare request with no X-Ingress-Path")
	}
	if got.AuthResult != "token" {
		t.Errorf("auth_result = %q, want token", got.AuthResult)
	}
	if got.ComputedExternalBase != "" {
		t.Errorf("computed_external_base = %q, want empty when not ingress", got.ComputedExternalBase)
	}
	if got.Verdicts.PathPrefix.Status != "warn" {
		t.Errorf("verdicts.path_prefix.status = %q, want warn (no X-Ingress-Path)", got.Verdicts.PathPrefix.Status)
	}
	if got.Verdicts.TokenFlow.Status != "ok" {
		t.Errorf("verdicts.token_flow.status = %q, want ok", got.Verdicts.TokenFlow.Status)
	}
}

func TestIngress_HTMLBranch(t *testing.T) {
	mux := ingressMux(t)

	rec := httptest.NewRecorder()
	// No Accept header, no ?format — the default is the HTML page.
	mux.ServeHTTP(rec, ingressRequest("/api/debug/ingress"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `<script type="application/json" id="report">`) {
		t.Error("HTML page is missing the embedded JSON report block")
	}
	if !strings.Contains(body, "new EventSource('ingress/sse-probe')") {
		t.Error("HTML page is missing the in-browser SSE probe script")
	}
	if !strings.Contains(body, `id="v-sse"`) {
		t.Error("HTML page is missing the SSE verdict element")
	}

	// The inline script must be allowed by a per-response CSP that carries
	// its SHA-256 (the app-wide script-src 'self' would otherwise block it).
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src '"+ingressProbeJSHash+"'") {
		t.Errorf("CSP = %q, want a script-src carrying %q", csp, ingressProbeJSHash)
	}
	if !strings.Contains(csp, "connect-src 'self'") {
		t.Errorf("CSP = %q, want connect-src 'self' for the EventSource probe", csp)
	}
}

func TestIngress_FormatQueryOverridesAccept(t *testing.T) {
	mux := ingressMux(t)

	// Accept says JSON, ?format=html wins -> HTML.
	rec := httptest.NewRecorder()
	req := ingressRequest("/api/debug/ingress?format=html")
	req.Header.Set("Accept", "application/json")
	mux.ServeHTTP(rec, req)
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("?format=html Content-Type = %q, want text/html", ct)
	}
}

func TestIngress_NotRegisteredInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	mux := ingressMux(t)

	for _, path := range []string{"/api/debug/ingress", "/api/debug/ingress/sse-probe"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s under NODE_ENV=production: status = %d, want 404", path, rec.Code)
		}
	}
}

func TestIngressSSEProbe_StreamsStaggeredTicks(t *testing.T) {
	mux := ingressMux(t)

	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/debug/ingress/sse-probe")
	if err != nil {
		t.Fatalf("GET sse-probe: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	for header, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-cache, no-transform",
		"X-Accel-Buffering": "no",
	} {
		if got := resp.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}

	type stamp struct {
		event string
		at    time.Time
	}
	var events []stamp
	sc := bufio.NewScanner(resp.Body)
	start := time.Now()
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "event: ") {
			events = append(events, stamp{event: strings.TrimPrefix(line, "event: "), at: time.Now()})
		}
	}
	if err := sc.Err(); err != nil && err != io.EOF {
		t.Fatalf("reading stream: %v", err)
	}

	var ticks []stamp
	var doneSeen bool
	for _, e := range events {
		switch e.event {
		case "tick":
			ticks = append(ticks, e)
		case "done":
			doneSeen = true
		}
	}

	if len(ticks) != sseProbeTicks {
		t.Fatalf("got %d tick events, want %d", len(ticks), sseProbeTicks)
	}
	if !doneSeen {
		t.Error("no done event")
	}

	// The 5 ticks are 200ms apart server-side; the whole thing sits under
	// the 3s deadline. Generous slack for CI: the last tick should land
	// clearly after the first (staggered, not batched), and the stream
	// should finish well under the hard deadline.
	span := ticks[len(ticks)-1].at.Sub(ticks[0].at)
	if span < 300*time.Millisecond {
		t.Errorf("tick span = %v, want >= 300ms (staggered, not batched)", span)
	}
	if total := time.Since(start); total > sseProbeDeadline+2*time.Second {
		t.Errorf("probe took %v, expected well under the %v deadline", total, sseProbeDeadline)
	}
}

func TestIngressSSEProbe_TickPayloadShape(t *testing.T) {
	mux := ingressMux(t)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/debug/ingress/sse-probe")
	if err != nil {
		t.Fatalf("GET sse-probe: %v", err)
	}
	defer resp.Body.Close()

	var firstTickData string
	sc := bufio.NewScanner(resp.Body)
	prevEventTick := false
	for sc.Scan() {
		line := sc.Text()
		if line == "event: tick" {
			prevEventTick = true
			continue
		}
		if prevEventTick && strings.HasPrefix(line, "data: ") {
			firstTickData = strings.TrimPrefix(line, "data: ")
			break
		}
		prevEventTick = false
	}
	if firstTickData == "" {
		t.Fatal("no tick data line seen")
	}

	var payload struct {
		N        int   `json:"n"`
		ServerMS int64 `json:"server_ms"`
	}
	if err := json.Unmarshal([]byte(firstTickData), &payload); err != nil {
		t.Fatalf("tick data %q is not JSON: %v", firstTickData, err)
	}
	if payload.N != 1 {
		t.Errorf("first tick n = %d, want 1", payload.N)
	}
	if payload.ServerMS <= 0 {
		t.Errorf("first tick server_ms = %d, want a positive unix-millis value", payload.ServerMS)
	}
}
