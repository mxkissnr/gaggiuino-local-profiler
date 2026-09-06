package importer

import (
	"context"
	"net"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file wires lib/ssrf-guard.js's assertPublicHost for GET /api/import/url,
// which fetches an arbitrary user-pasted URL. It does NOT define a new SSRF
// predicate: the private/loopback/link-local check is netguard.IsPrivateAddress
// (promoted out of internal/library in #901 Phase 2c — same threat model as
// that package's barcode-scan guard). This file keeps only what's genuinely
// per-package: the lookupIPAddr test seam every netguard consumer has, and
// the thin wrappers.

// lookupIPAddr is a package-level var so tests can substitute a fake
// resolver, exactly as internal/library/ssrf.go does.
var lookupIPAddr = net.DefaultResolver.LookupIPAddr

// assertPublicHost ports ssrf-guard.js's assertPublicHost(hostname).
func assertPublicHost(ctx context.Context, hostname string) error {
	return netguard.AssertHost(ctx, hostname, netguard.IsPrivateAddress, lookupIPAddr)
}

// assertPublicHostResolved is assertPublicHost's pin-friendly counterpart
// (#987) — see machines/ssrf.go's assertMachineHostResolved for the
// identical rationale. fetch.go's importDialer (a netguard.GuardedDialer)
// uses it to pin safeGet's actual TCP connection to the address this check
// approved, instead of letting net/http's transport re-resolve the
// hostname independently at connect time.
func assertPublicHostResolved(ctx context.Context, hostname string) (net.IP, error) {
	return netguard.AssertHostResolved(ctx, hostname, netguard.IsPrivateAddress, lookupIPAddr)
}

// isSSRFBlocked reports whether err is (or wraps) a netguard.ErrBlocked.
func isSSRFBlocked(err error) bool { return netguard.IsBlocked(err) }
