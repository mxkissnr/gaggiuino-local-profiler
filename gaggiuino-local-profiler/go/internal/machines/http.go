package machines

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfstats"
)

// maxMachineResponseBytes caps a machine response body at 8 MiB so a
// hostile machine cannot stream an unbounded response into memory.
const maxMachineResponseBytes = 8 << 20

// machinesDialer pins every real connection httpClient (and, via
// websocket.DialOptions, every WS dial in this package — ws.go/live.go/
// gaggimate_live.go/gaggimate_ws.go all pass HTTPClient: httpClient) opens
// to the exact IP machineHostGuardResolved just approved (#987), via the
// shared netguard.GuardedDialer (also used by internal/importer/fetch.go
// and internal/mqtt/client.go — one implementation, not three copies).
// The resolve closure reads machineHostGuardResolved.get() on every call
// so allowLoopbackMachineHost's test-time override is honored.
var machinesDialer = netguard.NewGuardedDialer(func(ctx context.Context, hostname string) (net.IP, error) {
	return machineHostGuardResolved.get()(ctx, hostname)
})

// machineTraffic is the process-wide machine-traffic counter cmd/server
// installs once at startup via SetMachineTrafficCounter. It is nil in tests
// and in any build without the developer tools, and every helper below is a
// no-op then (the counter's own methods are nil-receiver safe).
var machineTraffic atomic.Pointer[perfstats.MachineCounter]

// SetMachineTrafficCounter installs c as the process-wide machine-traffic
// counter the guards below feed. Call once, from cmd/server before any machine
// traffic starts.
func SetMachineTrafficCounter(c *perfstats.MachineCounter) {
	machineTraffic.Store(c)
}

// countMachineRequest records one outbound HTTP round trip to host. failed is
// true when the round trip errored or the response was a 5xx.
func countMachineRequest(host string, failed bool) {
	machineTraffic.Load().CountRequest(host, failed)
}

// countMachineWSMessage records one WebSocket message received from host.
func countMachineWSMessage(host string) {
	machineTraffic.Load().CountWSMessage(host)
}

// SetMachineBrewing records whether host is currently taking a shot, so the
// machine-traffic counter files that minute's requests in the brewing bucket.
// The poller calls it once per poll tick with the host normalized by
// NormalizeMachineHost; the counter lowercases the host key itself, so that
// key matches the as-typed host the counting round tripper records (e.g.
// GaggiMate.local:8080), and every adapter and fallback path is covered by one
// call.
func SetMachineBrewing(host string, brewing bool) {
	machineTraffic.Load().SetBrewing(host, brewing)
}

// hostFromBaseURL returns baseURL's host:port — the same key req.URL.Host
// yields for the HTTP calls to that machine — so a live session's WebSocket
// messages count against the same machine as its HTTP requests.
func hostFromBaseURL(baseURL string) string {
	u, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	return u.Host
}

// countingRoundTripper wraps a machine transport and records every round trip
// against the machine-traffic counter, keyed by the request's host. A WebSocket
// handshake carries an Upgrade header and is skipped: it is not an HTTP request
// to the machine, and its messages are counted separately.
type countingRoundTripper struct {
	base http.RoundTripper
}

func (t countingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if !strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		countMachineRequest(req.URL.Host, err != nil || (resp != nil && resp.StatusCode >= 500))
	}
	return resp, err
}

// httpClient is package-level (not http.DefaultClient directly) so tests
// can point it at an httptest.Server's transport if ever needed. Its
// Transport is deliberately a minimal custom one (not http.DefaultTransport)
// so machinesDialer is the only dialer in play — no environment-driven
// proxy that could route guarded traffic somewhere the guard never saw. The
// countingRoundTripper wrapper observes every call for get_perf_stats.
var httpClient = &http.Client{
	Transport: countingRoundTripper{base: &http.Transport{DialContext: machinesDialer.DialContext}},
}

// NewGuardedHTTPClient returns an *http.Client dialing exclusively through
// machinesDialer — the same guard httpClient above uses — for the two call
// sites outside this package that also reach a user-configured machine
// host over plain net/http: system/sync.go's manual shot-history pull and
// debug/debug.go's GET /api/debug/machine probe (#1049). Both used to build
// their own bare *http.Client, which left http.DefaultTransport (proxy-
// aware, no dial guard at all) in play — a hostname that passed
// machines.BaseURLFor's check at request time could still resolve
// somewhere else entirely by the time that unguarded transport dialed it
// (DNS rebinding), and a 3xx response would be followed there automatically.
//
// timeout sets the client's overall per-request Timeout (each call site
// keeps its own existing constant rather than sharing one here).
//
// CheckRedirect is deliberately left at net/http's default (follow, up to
// 10 hops) rather than refusing redirects outright: every hop's connection
// — including a redirected one — dials through this same guarded Transport,
// so a redirect to a blocked (loopback/link-local/metadata) address fails
// at dial time exactly like the initial request would; there is no
// separate window a CheckRedirect check would need to close. This differs
// from internal/importer/fetch.go, which fetches arbitrary user-pasted
// URLs (a wider threat model, assertPublicHost) and caps redirect hops
// explicitly for that reason — a user's own configured machine host has no
// such need.
func NewGuardedHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: countingRoundTripper{base: &http.Transport{DialContext: machinesDialer.DialContext}},
	}
}

// httpGetBytes issues a GET request and returns the raw response body
// bytes — deliberately not JSON-decoded-then-re-encoded anywhere along
// settings-proxy paths (see gaggiuino_adapter.go's GetSettings/
// UpdateSettings), so a field's exact on-wire JSON representation (e.g.
// the machine's bool-as-string settings quirk, see doc.go) survives the
// round trip byte-for-byte.
func httpGetBytes(ctx context.Context, url string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxMachineResponseBytes))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("machine responded %d: %s", resp.StatusCode, errorSnippet(body))
	}
	return body, nil
}

// httpGetBytesCapped is httpGetBytes but limits the response body to at
// most maxBytes via io.LimitReader, so an oversized reply from an
// untrusted machine can never be read fully into memory (#991) -- use it
// for any endpoint whose legitimate response size has a known, defensible
// upper bound (e.g. GaggiMate's index.bin, capped by gaggimate_history.go's
// entry-size math). An over-cap response is read only up to maxBytes,
// same truncate-not-reject behavior FetchGaggiMateShot's own
// io.LimitReader already relies on for .slog fetches.
func httpGetBytesCapped(ctx context.Context, url string, timeout time.Duration, maxBytes int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("machine responded %d: %s", resp.StatusCode, errorSnippet(body))
	}
	return body, nil
}

// httpPostBytes issues a POST request with an already-JSON-encoded body
// and returns the raw response body bytes, for the same byte-preservation
// reason httpGetBytes documents. An empty body posts `{}` (net/http.Post's
// convention for "no body" doesn't apply to a JSON API that expects an
// object, matching every axios.post(url, {}, ...) call site this ports).
func httpPostBytes(ctx context.Context, url string, body []byte, timeout time.Duration) ([]byte, error) {
	if len(body) == 0 {
		body = []byte("{}")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxMachineResponseBytes))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("machine responded %d: %s", resp.StatusCode, errorSnippet(respBody))
	}
	return respBody, nil
}

// errorSnippet renders a response body for an error message, whitespace
// trimmed and cut to at most 200 bytes (an ellipsis marks the cut) so an
// oversized or binary error body cannot flood a log or API response.
func errorSnippet(body []byte) string {
	s := strings.TrimSpace(string(body))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

// ── loose value coercion, mirroring JS's parseFloat/parseInt/!!/||null
// conventions on an untyped JSON-decoded value (used by GetStatus, whose
// source field types vary — the machine's REST status can carry numbers
// or numeric strings) ────────────────────────────────────────────────────

func looseFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	default:
		return 0
	}
}

func looseTruthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != ""
	case nil:
		return false
	default:
		return true
	}
}

func looseIntPtr(v any) *int {
	switch t := v.(type) {
	case float64:
		n := int(t)
		return &n
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return nil
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			return nil
		}
		return &n
	default:
		return nil
	}
}

func looseFloatOrNil(v any) *float64 {
	switch t := v.(type) {
	case float64:
		return &t
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return nil
		}
		return &f
	default:
		return nil
	}
}

func looseStringPtr(v any) *string {
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	return &s
}
