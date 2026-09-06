package machines

import (
	"context"
	"net"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file ports lib/ssrf-guard.js's assertMachineHost — the narrower of
// its two guards (see internal/library/ssrf.go for assertPublicHost, the
// wider one that guards untrusted external content). A machine host is the
// app owner's own trusted LAN configuration, not untrusted external
// content — the opposite threat model, so only loopback/link-local/cloud-
// metadata addresses are blocked here, NOT the RFC1918 ranges
// assertPublicHost blocks (a real Gaggiuino/GaggiMate machine lives in
// exactly those ranges, #336). The actual resolve-then-check plumbing both
// variants share now lives in internal/netguard (#901 code review) — this
// file keeps only what's genuinely specific to this package's threat model:
// the loopback/metadata predicate and the lookupIPAddr test seam.

// lookupIPAddr is a package-level var so tests can substitute a fake
// resolver instead of depending on real DNS or real address literals.
var lookupIPAddr = net.DefaultResolver.LookupIPAddr

// isLoopbackOrMetadataIPv4 ports ssrf-guard.js's isLoopbackOrMetadataIPv4.
func isLoopbackOrMetadataIPv4(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return true // fail closed on garbage
	}
	a, b := v4[0], v4[1]
	if a == 0 || a == 127 {
		return true
	}
	if a == 169 && b == 254 {
		return true // link-local, incl. cloud metadata (169.254.169.254)
	}
	return false
}

// isLoopbackOrMetadataIPv6 ports ssrf-guard.js's isLoopbackOrMetadataIPv6.
func isLoopbackOrMetadataIPv6(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() {
		return true
	}
	b16 := ip.To16()
	if b16 == nil {
		return true
	}
	if b16[0] == 0xfe && (b16[1]&0xc0) == 0x80 {
		return true // fe80::/10 link-local
	}
	return false
}

func isLoopbackOrMetadataAddress(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		return isLoopbackOrMetadataIPv4(v4)
	}
	return isLoopbackOrMetadataIPv6(ip)
}

// assertMachineHost ports ssrf-guard.js's assertMachineHost(hostname), via
// internal/netguard's shared AssertHost.
func assertMachineHost(ctx context.Context, hostname string) error {
	return netguard.AssertHost(ctx, hostname, isLoopbackOrMetadataAddress, lookupIPAddr)
}

// assertMachineHostResolved is assertMachineHost's pin-friendly counterpart
// (#987): returns the resolved (or literal) IP that passed the guard, so
// guardedDialContext (http.go) can dial that literal address instead of
// letting net/http's own dialer re-resolve the hostname independently at
// connect time — closing the DNS-rebinding window between this check and
// the actual TCP connection.
func assertMachineHostResolved(ctx context.Context, hostname string) (net.IP, error) {
	return netguard.AssertHostResolved(ctx, hostname, isLoopbackOrMetadataAddress, lookupIPAddr)
}

// isSSRFBlocked reports whether err is (or wraps) an ErrBlocked from a
// failed assertMachineHost call.
func isSSRFBlocked(err error) bool {
	return netguard.IsBlocked(err)
}

// AssertMachineHost exports assertMachineHost's exact loopback/link-local/
// cloud-metadata guard for other packages that validate a user-supplied LAN
// host under the same threat model as a machine's own host (#988: an MQTT
// broker host is exactly this — a real LAN broker legitimately lives in
// RFC1918 space, same as a real machine). Reuses the guard directly (not
// the machineHostGuard test seam) so an external caller always gets the
// real check.
func AssertMachineHost(ctx context.Context, hostname string) error {
	return assertMachineHost(ctx, hostname)
}

// AssertMachineHostResolved exports assertMachineHostResolved for the same
// reason AssertMachineHost exports assertMachineHost — mqtt/client.go's
// guarded MQTT dialer (#988 code review: paho's own auto-reconnect needs
// the pin-friendly resolved-IP variant, not just the pass/fail check) uses
// this rather than reimplementing the resolve-then-check plumbing.
func AssertMachineHostResolved(ctx context.Context, hostname string) (net.IP, error) {
	return assertMachineHostResolved(ctx, hostname)
}
