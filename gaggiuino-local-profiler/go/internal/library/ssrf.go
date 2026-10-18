package library

import (
	"context"
	"net"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file provides assertPublicHost, the pre-flight SSRF check the
// library's outbound fetches (scan.go, image.go, geo.go) run before their
// request: it resolves the hostname and rejects it if any address is
// private/loopback/link-local. #1626: the connection itself is pinned too —
// all three clients dial through newGuardedTransport, a
// netguard.GuardedDialer over assertPublicHostResolved, exactly like
// internal/importer, so a DNS answer that changes between the pre-flight
// check and the dial is caught at connect time. Like the importer's, that
// transport sets no Proxy, so these lookups ignore proxy environment
// variables. The resolve-then-check plumbing lives in internal/netguard.

// lookupIPAddr is a package-level var (not a bare net.DefaultResolver call)
// so tests can substitute a fake resolver instead of depending on real DNS
// or real private/public IP literals being reachable in CI.
var lookupIPAddr = net.DefaultResolver.LookupIPAddr

// assertPublicHost validates hostname via internal/netguard's shared
// AssertHost + IsPrivateAddress predicate. The private/loopback/link-local IP
// predicate moved to internal/netguard so internal/importer
// (GET /api/import/url) — same threat model — can reuse it without a third
// copy; see netguard/private.go.
func assertPublicHost(ctx context.Context, hostname string) error {
	return netguard.AssertHost(ctx, hostname, netguard.IsPrivateAddress, lookupIPAddr)
}

// assertPublicHostResolved is assertPublicHost's pin-friendly counterpart
// (#987): same check, returning the approved address for libraryDialer to
// connect to.
func assertPublicHostResolved(ctx context.Context, hostname string) (net.IP, error) {
	return netguard.AssertHostResolved(ctx, hostname, netguard.IsPrivateAddress, lookupIPAddr)
}

// libraryDialer pins each library fetch's TCP connection to the address
// assertPublicHostResolved just approved, instead of letting net/http
// re-resolve the hostname at connect time (#1626, same as importer's
// importDialer).
var libraryDialer = netguard.NewGuardedDialer(assertPublicHostResolved)

// newGuardedTransport returns the transport every library fetch client uses.
func newGuardedTransport() *http.Transport {
	return &http.Transport{DialContext: libraryDialer.DialContext}
}

// isSSRFBlocked reports whether err is (or wraps) an ErrBlocked from a
// failed assertPublicHost call.
func isSSRFBlocked(err error) bool {
	return netguard.IsBlocked(err)
}
