package machines

import (
	"context"
	"errors"
	"net"
	"testing"
)

// TestGuardedDialContext_PinsResolvedIP is the #987 regression test for the
// DNS-rebinding TOCTOU: guardedDialContext must dial the exact IP
// machineHostGuardResolved approved, never the raw hostname (which would
// let net/http's own dialer re-resolve it a second time, giving a
// rebinding attacker's second, independent lookup a chance to answer
// differently than the one the guard just checked).
func TestGuardedDialContext_PinsResolvedIP(t *testing.T) {
	origResolved := machineHostGuardResolved
	origDial := rawDialContext
	t.Cleanup(func() {
		machineHostGuardResolved = origResolved
		rawDialContext = origDial
	})

	const approvedIP = "192.168.1.50"
	machineHostGuardResolved = func(ctx context.Context, hostname string) (net.IP, error) {
		if hostname != "gaggiuino.local" {
			t.Fatalf("unexpected hostname passed to the guard: %q", hostname)
		}
		return net.ParseIP(approvedIP), nil
	}

	var dialedAddr string
	sentinel := errors.New("test dial stub")
	rawDialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialedAddr = addr
		return nil, sentinel
	}

	_, err := guardedDialContext(context.Background(), "tcp", "gaggiuino.local:80")
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected the stub dial error to propagate, got %v", err)
	}
	want := approvedIP + ":80"
	if dialedAddr != want {
		t.Fatalf("dialed %q, want %q (the guard-approved IP, not the raw hostname)", dialedAddr, want)
	}
}

// TestGuardedDialContext_BlocksWhenGuardRejects proves a rejected host never
// reaches the dialer at all.
func TestGuardedDialContext_BlocksWhenGuardRejects(t *testing.T) {
	origResolved := machineHostGuardResolved
	origDial := rawDialContext
	t.Cleanup(func() {
		machineHostGuardResolved = origResolved
		rawDialContext = origDial
	})

	guardErr := errors.New("blocked")
	machineHostGuardResolved = func(ctx context.Context, hostname string) (net.IP, error) {
		return nil, guardErr
	}
	dialed := false
	rawDialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = true
		return nil, nil
	}

	_, err := guardedDialContext(context.Background(), "tcp", "evil.example:80")
	if !errors.Is(err, guardErr) {
		t.Fatalf("expected guard error to propagate, got %v", err)
	}
	if dialed {
		t.Fatal("dial function was called despite the guard rejecting the host")
	}
}
