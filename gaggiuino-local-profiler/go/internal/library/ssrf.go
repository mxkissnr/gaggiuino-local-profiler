package library

import (
	"context"
	"net"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file provides assertPublicHost, the pre-flight SSRF check the
// library's outbound fetches (scan.go, image.go, geo.go) run before their
// request: it resolves the hostname and rejects it if any address is
// private/loopback/link-local. It does NOT pin the later connection to the
// checked address — the request's http.Client resolves the hostname again
// when it dials, so a DNS answer that changes between the two lookups is not
// caught. internal/importer pins its dial with netguard.GuardedDialer
// instead. The resolve-then-check plumbing lives in internal/netguard.

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

// isSSRFBlocked reports whether err is (or wraps) an ErrBlocked from a
// failed assertPublicHost call.
func isSSRFBlocked(err error) bool {
	return netguard.IsBlocked(err)
}
