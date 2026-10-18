package netguard

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
)

// TestGuardedDialer_PinsResolvedIP is the #987 regression test for the
// DNS-rebinding TOCTOU: GuardedDialer.DialContext must dial the exact IP
// Resolve approved, never the raw hostname (which would let a plain
// dialer re-resolve it a second time, giving a rebinding attacker's
// second, independent lookup a chance to answer differently than the one
// the guard just checked). One shared test for the one shared type — both
// internal/machines and internal/importer construct a GuardedDialer, so a
// future fix to this logic can't be applied to one copy and miss another.
func TestGuardedDialer_PinsResolvedIP(t *testing.T) {
	const approvedIP = "192.168.1.50"
	d := &GuardedDialer{
		Resolve: func(ctx context.Context, hostname string) (net.IP, error) {
			if hostname != "gaggiuino.local" {
				t.Fatalf("unexpected hostname passed to the guard: %q", hostname)
			}
			return net.ParseIP(approvedIP), nil
		},
	}
	var dialedAddr string
	sentinel := errors.New("test dial stub")
	d.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialedAddr = addr
		return nil, sentinel
	}

	_, err := d.DialContext(context.Background(), "tcp", "gaggiuino.local:80")
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected the stub dial error to propagate, got %v", err)
	}
	want := approvedIP + ":80"
	if dialedAddr != want {
		t.Fatalf("dialed %q, want %q (the guard-approved IP, not the raw hostname)", dialedAddr, want)
	}
}

// TestGuardedDialer_BlocksWhenGuardRejects proves a rejected host never
// reaches the dialer at all.
func TestGuardedDialer_BlocksWhenGuardRejects(t *testing.T) {
	guardErr := errors.New("blocked")
	d := &GuardedDialer{
		Resolve: func(ctx context.Context, hostname string) (net.IP, error) { return nil, guardErr },
	}
	dialed := false
	d.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = true
		return nil, nil
	}

	_, err := d.DialContext(context.Background(), "tcp", "evil.example:80")
	if !errors.Is(err, guardErr) {
		t.Fatalf("expected guard error to propagate, got %v", err)
	}
	if dialed {
		t.Fatal("dial function was called despite the guard rejecting the host")
	}
}

// TestNewGuardedDialer_DefaultsToRealDialer proves NewGuardedDialer wires a
// real net.Dialer by default (not nil) — a construction-time smoke test,
// not a network test: an invalid network name fails inside net.Dialer
// itself, proving Dial is non-nil and actually invoked.
func TestNewGuardedDialer_DefaultsToRealDialer(t *testing.T) {
	d := NewGuardedDialer(func(ctx context.Context, hostname string) (net.IP, error) {
		return net.ParseIP("127.0.0.1"), nil
	})
	if d.Dial == nil {
		t.Fatal("NewGuardedDialer left Dial nil")
	}
	if _, err := d.DialContext(context.Background(), "not-a-network", "127.0.0.1:80"); err == nil {
		t.Fatal("expected an error dialing an invalid network")
	}
}

// TestAssertHostResolved_StripsResolverAddress is the #1691 regression test:
// a real *net.DNSError formats as "lookup HOST on RESOLVER:53: no such host",
// so wrapping it verbatim leaked the runner's resolver IP into the /api/status
// and /api/machine/live payloads and tripped the demo-fixtures personal-data
// leak check. AssertHostResolved must strip Server while keeping the hostname,
// the DNS failure reason, and the *net.DNSError type for errors.As callers.
func TestAssertHostResolved_StripsResolverAddress(t *testing.T) {
	lookup := func(ctx context.Context, hostname string) ([]net.IPAddr, error) {
		return nil, &net.DNSError{
			Err:        "no such host",
			Name:       "gaggiuino.local",
			Server:     "168.63.129.16:53",
			IsNotFound: true,
		}
	}
	_, err := AssertHostResolved(context.Background(), "gaggiuino.local", func(net.IP) bool { return false }, lookup)
	if err == nil {
		t.Fatal("expected an error from a failing lookup")
	}
	if strings.Contains(err.Error(), "168.63.129.16") {
		t.Fatalf("error text leaked the resolver address: %v", err)
	}
	if !strings.Contains(err.Error(), "gaggiuino.local") {
		t.Fatalf("error text lost the hostname: %v", err)
	}
	if !strings.Contains(err.Error(), "no such host") {
		t.Fatalf("error text lost the DNS failure reason: %v", err)
	}
	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) {
		t.Fatalf("expected errors.As to still find a *net.DNSError, got %T: %v", err, err)
	}
}
