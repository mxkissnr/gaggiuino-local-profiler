package machines

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// withAllowedLoopbackHost overrides machineHostGuardResolved (the seam
// guardedDialContext / machinesDialer reads on every dial) so exactly the
// given loopback hostname/IP passes, while every other host still goes
// through the real assertMachineHostResolved guard. This is narrower than
// helpers_test.go's allowLoopbackMachineHost (which blanket-allows any
// parseable IP) on purpose: TestNewGuardedHTTPClient_RedirectToBlockedAddressFails
// needs the primary httptest.Server's loopback address to dial, while
// still exercising the real guard against the redirect's blocked target.
func withAllowedLoopbackHost(t *testing.T, allowed string) {
	t.Helper()
	orig := machineHostGuardResolved.set(func(ctx context.Context, hostname string) (net.IP, error) {
		if hostname == allowed {
			return net.ParseIP(allowed), nil
		}
		return assertMachineHostResolved(ctx, hostname)
	})
	t.Cleanup(func() { machineHostGuardResolved.set(orig) })
}

// TestNewGuardedHTTPClient_NormalFetchSucceeds is the baseline half of the
// #1049 regression test: a plain, non-redirected GET through
// NewGuardedHTTPClient against an allowed host still works end to end.
func TestNewGuardedHTTPClient_NormalFetchSucceeds(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok")
	}))
	defer primary.Close()
	withAllowedLoopbackHost(t, "127.0.0.1")

	client := NewGuardedHTTPClient(2 * time.Second)
	resp, err := client.Get(primary.URL)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Fatalf("body = %q, want %q", body, "ok")
	}
}

// TestNewGuardedHTTPClient_RedirectToBlockedAddressFails is the #1049
// regression test: system/sync.go and debug/debug.go previously built bare
// *http.Client values (http.DefaultTransport, no dial guard) for the same
// user-configured machine host machines.BaseURLFor already validates —
// letting a redirect to a loopback/link-local/metadata address through
// unchecked. NewGuardedHTTPClient's Transport dials every hop (including a
// followed redirect) through machinesDialer, so the second hop must fail
// here exactly like a direct request to that address would.
func TestNewGuardedHTTPClient_RedirectToBlockedAddressFails(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 169.254.169.254 is the cloud-metadata address — always blocked by
		// assertMachineHost's loopback/link-local/metadata predicate, no
		// DNS fake or override needed, and nothing needs to actually listen
		// there since the guard must reject it before a dial is attempted.
		http.Redirect(w, r, "http://169.254.169.254/metadata", http.StatusFound)
	}))
	defer primary.Close()
	withAllowedLoopbackHost(t, "127.0.0.1")

	client := NewGuardedHTTPClient(2 * time.Second)
	resp, err := client.Get(primary.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("expected a redirect to a blocked address to fail, got a response")
	}
	if !isSSRFBlocked(err) {
		t.Fatalf("expected an SSRF-blocked error, got: %v", err)
	}
}
