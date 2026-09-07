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

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

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

// httpClient is package-level (not http.DefaultClient directly) so tests
// can point it at an httptest.Server's transport if ever needed. Its
// Transport is deliberately a minimal custom one (not http.DefaultTransport)
// so machinesDialer is the only dialer in play — no environment-driven
// proxy that could route guarded traffic somewhere the guard never saw.
var httpClient = &http.Client{
	Transport: &http.Transport{DialContext: machinesDialer.DialContext},
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
