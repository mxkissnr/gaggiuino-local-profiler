package netguard

import (
	"context"
	"errors"
	"net"
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
