package machines

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// rawDialContext is (&net.Dialer{}).DialContext by default — a package-
// level var so tests can substitute a stub that records the address it
// was asked to dial instead of opening a real socket (#987's regression
// test, http_test.go).
var rawDialContext = (&net.Dialer{}).DialContext

// guardedDialContext pins every real connection httpClient (and, via
// websocket.DialOptions, every WS dial in this package — ws.go/live.go/
// gaggimate_live.go/gaggimate_ws.go all pass HTTPClient: httpClient) opens
// to the exact IP machineHostGuardResolved just approved, instead of
// handing net/http's own dialer the raw hostname to resolve independently
// (#987): BaseURLFor/assertMachineHost already validate the hostname before
// a request is built, but net/http's default dialer would otherwise
// re-resolve that same hostname a second time at connect time — a DNS-
// rebinding attacker who controls the answer gets a second, independent
// lookup to pass a blocked address through. Resolving once here (via the
// same guard) and dialing that literal address closes the window; the
// request's URL/Host header keep the original hostname unchanged, so TLS
// SNI and certificate validation (for an https:// machine host) are
// unaffected — only the wire-level connection target is pinned.
func guardedDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ip, err := machineHostGuardResolved(ctx, host)
	if err != nil {
		return nil, err
	}
	return rawDialContext(ctx, network, net.JoinHostPort(ip.String(), port))
}

// httpClient is package-level (not http.DefaultClient directly) so tests
// can point it at an httptest.Server's transport if ever needed. Its
// Transport is deliberately a minimal custom one (not http.DefaultTransport)
// so guardedDialContext is the only dialer in play — no environment-driven
// proxy that could route guarded traffic somewhere the guard never saw.
var httpClient = &http.Client{
	Transport: &http.Transport{DialContext: guardedDialContext},
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
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("machine responded %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
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
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("machine responded %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return respBody, nil
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
