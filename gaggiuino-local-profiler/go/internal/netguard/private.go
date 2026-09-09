package netguard

import "net"

// IsPrivateAddress ports lib/ssrf-guard.js's isPrivateAddress predicate:
// net.isIPv4(ip) ? isPrivateIPv4(ip) : isPrivateIPv6(ip). It blocks
// private/loopback/link-local/CGNAT space — the "used against untrusted
// external hosts" threat model this package's header comment describes.
//
// It lived in internal/library/ssrf.go until #901's Phase 2c: internal/importer
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
	if v4 := ip.To4(); v4 != nil {
		return isPrivateIPv4(v4)
	}
	return isPrivateIPv6(ip)
}

// isPrivateIPv4 ports ssrf-guard.js's isPrivateIPv4.
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
	return false
}

// isPrivateIPv6 ports ssrf-guard.js's isPrivateIPv6 — only reached for a
// genuine (non-v4-mapped) IPv6 address; IsPrivateAddress routes v4-mapped
// addresses (::ffff:a.b.c.d) through isPrivateIPv4 instead, the same branch
// ssrf-guard.js's own isPrivateIPv6 takes internally.
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
	return false
}
