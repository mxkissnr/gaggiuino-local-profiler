package machines

import (
	"context"
	"net"
	"testing"
)

func withFakeMachineLookup(t *testing.T, addrs map[string][]net.IP) {
	t.Helper()
	orig := lookupIPAddr
	lookupIPAddr = func(ctx context.Context, host string) ([]net.IPAddr, error) {
		ips, ok := addrs[host]
		if !ok {
			return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
		}
		out := make([]net.IPAddr, len(ips))
		for i, ip := range ips {
			out[i] = net.IPAddr{IP: ip}
		}
		return out, nil
	}
	t.Cleanup(func() { lookupIPAddr = orig })
}

// A real machine host legitimately lives in RFC1918 space (#336) —
// assertMachineHost must allow it, unlike internal/library's wider
// assertPublicHost.
func TestAssertMachineHost_AllowsPrivateLANAddress(t *testing.T) {
	cases := []string{"192.168.1.50", "10.0.0.5", "172.20.0.10"}
	for _, ip := range cases {
		t.Run(ip, func(t *testing.T) {
			withFakeMachineLookup(t, map[string][]net.IP{"gaggiuino.local": {net.ParseIP(ip)}})
			if err := assertMachineHost(context.Background(), "gaggiuino.local"); err != nil {
				t.Fatalf("expected a LAN address to pass assertMachineHost, got: %v", err)
			}
		})
	}
}

func TestAssertMachineHost_BlocksLoopbackAndMetadata(t *testing.T) {
	cases := []string{"127.0.0.1", "169.254.169.254", "0.0.0.0"}
	for _, ip := range cases {
		t.Run(ip, func(t *testing.T) {
			withFakeMachineLookup(t, map[string][]net.IP{"evil.example": {net.ParseIP(ip)}})
			err := assertMachineHost(context.Background(), "evil.example")
			if err == nil || !isSSRFBlocked(err) {
				t.Fatalf("expected ErrSSRFBlocked for %s, got %v", ip, err)
			}
		})
	}
}

func TestAssertMachineHost_BlocksLinkLocalIPv6(t *testing.T) {
	withFakeMachineLookup(t, map[string][]net.IP{"evil6.example": {net.ParseIP("fe80::1")}})
	err := assertMachineHost(context.Background(), "evil6.example")
	if err == nil || !isSSRFBlocked(err) {
		t.Fatalf("expected ErrSSRFBlocked for fe80::1, got %v", err)
	}
}

func TestAssertMachineHost_LiteralIP(t *testing.T) {
	if err := assertMachineHost(context.Background(), "192.168.1.1"); err != nil {
		t.Fatalf("expected a literal LAN IP to pass, got: %v", err)
	}
	if err := assertMachineHost(context.Background(), "127.0.0.1"); err == nil || !isSSRFBlocked(err) {
		t.Fatalf("expected a literal loopback IP to be blocked, got %v", err)
	}
}

func TestAssertMachineHost_UnresolvableIsPlainError(t *testing.T) {
	withFakeMachineLookup(t, map[string][]net.IP{})
	err := assertMachineHost(context.Background(), "nowhere.example")
	if err == nil {
		t.Fatal("expected an error for an unresolvable host")
	}
	if isSSRFBlocked(err) {
		t.Fatal("an unresolvable host must be a plain error, not ErrSSRFBlocked")
	}
}
