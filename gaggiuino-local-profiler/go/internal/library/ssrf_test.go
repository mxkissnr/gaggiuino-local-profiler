package library

import (
	"context"
	"net"
	"testing"
)

func withFakeLookup(t *testing.T, addrs map[string][]net.IP) {
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

func TestAssertPublicHost_AllowsPublicAddress(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{"example.com": {net.ParseIP("93.184.216.34")}})
	if err := assertPublicHost(context.Background(), "example.com"); err != nil {
		t.Fatalf("expected a public address to pass, got: %v", err)
	}
}

func TestAssertPublicHost_BlocksPrivateIPv4(t *testing.T) {
	cases := []string{"10.0.0.1", "172.16.5.5", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1"}
	for _, ip := range cases {
		t.Run(ip, func(t *testing.T) {
			withFakeLookup(t, map[string][]net.IP{"evil.example": {net.ParseIP(ip)}})
			err := assertPublicHost(context.Background(), "evil.example")
			if err == nil || !isSSRFBlocked(err) {
				t.Fatalf("expected ErrSSRFBlocked for %s, got %v", ip, err)
			}
		})
	}
}

func TestAssertPublicHost_BlocksPrivateIPv6(t *testing.T) {
	cases := []string{"::1", "fe80::1", "fc00::1", "fd12:3456::1"}
	for _, ip := range cases {
		t.Run(ip, func(t *testing.T) {
			withFakeLookup(t, map[string][]net.IP{"evil6.example": {net.ParseIP(ip)}})
			err := assertPublicHost(context.Background(), "evil6.example")
			if err == nil || !isSSRFBlocked(err) {
				t.Fatalf("expected ErrSSRFBlocked for %s, got %v", ip, err)
			}
		})
	}
}

func TestAssertPublicHost_LiteralIPCheckedDirectly(t *testing.T) {
	if err := assertPublicHost(context.Background(), "127.0.0.1"); err == nil || !isSSRFBlocked(err) {
		t.Fatalf("expected a literal loopback IP to be blocked without a DNS lookup, got %v", err)
	}
}

func TestAssertPublicHost_UnresolvableHostIsOrdinaryError(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{})
	err := assertPublicHost(context.Background(), "nowhere.invalid")
	if err == nil {
		t.Fatal("expected an error for an unresolvable host")
	}
	if isSSRFBlocked(err) {
		t.Fatal("an unresolvable host should be an ordinary error, not ErrSSRFBlocked")
	}
}

func TestIsAllowedImageURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://kaffeebraun.com/img/x.jpg", true},
		{"https://cdn.shopify.com/foo.png", true},
		{"http://www.elbgold.com/x.png", true},
		{"https://evil.example/x.jpg", false},
		{"ftp://cdn.shopify.com/x.jpg", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := isAllowedImageURL(c.url); got != c.want {
			t.Errorf("isAllowedImageURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}
