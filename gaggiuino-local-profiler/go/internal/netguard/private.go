package netguard

import "net"

// IsPrivateAddress reports whether ip is private, routing IPv4 and
// v4-mapped addresses through isPrivateIPv4 and the rest through
// isPrivateIPv6. It blocks private/loopback/link-local/CGNAT space — the
// "used against untrusted external hosts" threat model this package's
// header comment describes.
//
// It lived in internal/library/ssrf.go until #901: internal/importer
// (GET /api/import/url, which fetches an arbitrary user-pasted URL) needs the
// exact same predicate as internal/library's barcode-scan guard — same threat
// model, not a new one — so the predicate is promoted here rather than
// copy-pasted a third time. internal/machines keeps its own, looser
// assertMachineHost predicate (loopback/link-local/metadata only, RFC1918
// allowed for the owner's own LAN machines) — that one is genuinely
// domain-specific and stays in internal/machines/ssrf.go.
//
// Each importing package still keeps its own package-level lookupIPAddr test
// seam and calls AssertHost with it, exactly as before.
func IsPrivateAddress(ip net.IP) bool {
	if ip == nil {
		return true // unrecognised format — fail closed
	}
	if v4 := EmbeddedIPv4(ip); v4 != nil {
		return isPrivateIPv4(v4)
	}
	return isPrivateIPv6(ip)
}

// EmbeddedIPv4 returns the IPv4 address embedded in ip, or nil when ip does
// not embed one. It understands IPv4 itself and the IPv4-mapped form
// (::ffff:a.b.c.d) via net.IP.To4, plus the IPv4-compatible (::a.b.c.d,
// excluding the unspecified and loopback addresses), NAT64 (64:ff9b::/96)
// and 6to4 (2002::/16, bits 16-47) forms, so a caller applying its IPv4
// predicate to the result also rejects addresses like ::127.0.0.1 or
// 64:ff9b::7f00:1 that would otherwise look like public IPv6.
func EmbeddedIPv4(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	b16 := ip.To16()
	if b16 == nil {
		return nil
	}
	if allZero(b16[:12]) && !allZero(b16[12:]) && !(allZero(b16[12:15]) && b16[15] == 1) {
		return net.IPv4(b16[12], b16[13], b16[14], b16[15]) // ::a.b.c.d
	}
	if b16[0] == 0x00 && b16[1] == 0x64 && b16[2] == 0xff && b16[3] == 0x9b && allZero(b16[4:12]) {
		return net.IPv4(b16[12], b16[13], b16[14], b16[15]) // 64:ff9b::/96
	}
	if b16[0] == 0x20 && b16[1] == 0x02 {
		return net.IPv4(b16[2], b16[3], b16[4], b16[5]) // 2002::/16
	}
	return nil
}

func allZero(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}

// blockedIPv4Nets and blockedIPv6Nets are the non-public ranges that read
// more clearly as CIDRs than as byte comparisons. Parsed once at package
// initialisation.
var (
	blockedIPv4Nets = mustParseCIDRs(
		"198.18.0.0/15", // benchmarking (RFC 2544)
		"192.0.0.0/24",  // IETF protocol assignments (RFC 6890)
		"224.0.0.0/4",   // multicast
		"240.0.0.0/4",   // reserved, incl. limited broadcast
	)
	blockedIPv6Nets = mustParseCIDRs(
		"fec0::/10", // site-local (deprecated by RFC 3879)
		"ff00::/8",  // multicast
	)
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			panic("netguard: invalid built-in CIDR " + cidr + ": " + err.Error())
		}
		nets = append(nets, n)
	}
	return nets
}

func isPrivateIPv4(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return true // fail closed on garbage
	}
	a, b := v4[0], v4[1]
	if a == 0 || a == 10 || a == 127 {
		return true
	}
	if a == 169 && b == 254 {
		return true // link-local
	}
	if a == 172 && b >= 16 && b <= 31 {
		return true // RFC1918
	}
	if a == 192 && b == 168 {
		return true // RFC1918
	}
	if a == 100 && b >= 64 && b <= 127 {
		return true // CGNAT (RFC6598)
	}
	for _, n := range blockedIPv4Nets {
		if n.Contains(v4) {
			return true
		}
	}
	return false
}

// isPrivateIPv6 is only reached for IPv6 addresses that do not embed an
// IPv4 address; EmbeddedIPv4 unwraps those (and IPv4 itself) first.
func isPrivateIPv6(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() {
		return true
	}
	b16 := ip.To16()
	if b16 == nil {
		return true // fail closed on garbage
	}
	if b16[0] == 0xfe && (b16[1]&0xc0) == 0x80 {
		return true // fe80::/10 link-local
	}
	if (b16[0] & 0xfe) == 0xfc {
		return true // fc00::/7 unique local
	}
	for _, n := range blockedIPv6Nets {
		if n.Contains(b16) {
			return true
		}
	}
	return false
}
