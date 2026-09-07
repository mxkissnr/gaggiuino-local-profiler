package importer

import (
	"context"
	"net"
	"testing"
)

// Mirrors internal/library/ssrf_test.go — the SSRF guard on GET /api/import/url
// reuses netguard.IsPrivateAddress (the promoted shared predicate), with this
// package's own lookupIPAddr test seam.

func withFakeLookup(t *testing.T, addrs map[string][]net.IP) {
	t.Helper()
	orig := lookupIPAddr
	lookupIPAddr = func(_ context.Context, host string) ([]net.IPAddr, error) {
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

func TestAssertPublicHost_AllowsPublic(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{"example.com": {net.ParseIP("93.184.216.34")}})
	if err := assertPublicHost(context.Background(), "example.com"); err != nil {
		t.Fatalf("expected public address to pass, got %v", err)
	}
}

func TestAssertPublicHost_BlocksPrivate(t *testing.T) {
	for _, ip := range []string{"10.0.0.1", "172.16.5.5", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fc00::1"} {
		t.Run(ip, func(t *testing.T) {
			withFakeLookup(t, map[string][]net.IP{"evil.example": {net.ParseIP(ip)}})
			err := assertPublicHost(context.Background(), "evil.example")
			if err == nil || !isSSRFBlocked(err) {
				t.Fatalf("expected blocked for %s, got %v", ip, err)
			}
		})
	}
}

func TestAssertPublicHost_LiteralLoopback(t *testing.T) {
	if err := assertPublicHost(context.Background(), "127.0.0.1"); err == nil || !isSSRFBlocked(err) {
		t.Fatalf("expected literal loopback blocked without DNS, got %v", err)
	}
}

func TestAssertPublicHost_UnresolvableIsOrdinaryError(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{})
	err := assertPublicHost(context.Background(), "nowhere.invalid")
	if err == nil || isSSRFBlocked(err) {
		t.Fatalf("expected an ordinary (non-blocked) error, got %v", err)
	}
}
