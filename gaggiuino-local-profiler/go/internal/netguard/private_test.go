package netguard

import (
	"net"
	"testing"
)

func TestIsPrivateAddress(t *testing.T) {
	tests := []struct {
		addr    string
		private bool
	}{
		// IPv4 ranges added in #1747.
		{"198.18.0.1", true},
		{"198.19.255.255", true},
		{"198.17.255.255", false},
		{"198.20.0.1", false},
		{"192.0.0.8", true},
		{"192.0.0.255", true},
		{"192.0.1.1", false},
		{"224.0.0.1", true},
		{"239.255.255.255", true},
		{"223.255.255.255", false},
		{"240.0.0.1", true},
		{"255.255.255.255", true},

		// IPv6 ranges added in #1747.
		{"fec0::1", true},
		{"feff:ffff::1", true},
		{"fe00::1", false},
		{"ff00::", true},
		{"ff02::1", true},

		// Existing IPv6 checks stay in force.
		{"::", true},
		{"::1", true},
		{"fe80::1", true},
		{"fc00::1", true},

		// Addresses that embed an IPv4 address.
		{"::127.0.0.1", true},
		{"::ffff:127.0.0.1", true},
		{"64:ff9b::7f00:1", true},
		{"64:ff9b::a9fe:a9fe", true},
		{"64:ff9b::c0a8:101", true},
		{"2002:7f00:1::1", true},
		{"2002:c0a8:0101::1", true},
		{"2002:a9fe:a9fe::1", true},

		// Public controls.
		{"8.8.8.8", false},
		{"2606:4700::1111", false},
		{"64:ff9b::808:808", false},
		{"64:ff9b::101:101", false},
		{"2002:0808:0808::1", false},
		{"2002:0101:0101::1", false},
		{"::8.8.8.8", false},
		{"::ffff:8.8.8.8", false},
	}

	for _, tc := range tests {
		t.Run(tc.addr, func(t *testing.T) {
			ip := net.ParseIP(tc.addr)
			if ip == nil {
				t.Fatalf("bad test address %q", tc.addr)
			}
			if got := IsPrivateAddress(ip); got != tc.private {
				t.Errorf("IsPrivateAddress(%s) = %v, want %v", tc.addr, got, tc.private)
			}
		})
	}
}
