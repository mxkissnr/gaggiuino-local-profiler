package library

import (
	"context"
	"net"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file ports lib/ssrf-guard.js's assertPublicHost — used by the
// barcode-scan endpoint (scan.go) as a DNS-rebinding guard on
// world.openfoodfacts.org: that hostname is a fixed literal, not user
// input, but a compromised/rebound DNS answer for it could still point at
// an internal address, so every resolved address is checked before the
// request is allowed to proceed. assertMachineHost (the looser
// loopback/link-local-only variant used by routes/machines.js) is NOT
// ported here — it belongs to the not-yet-ported machines domain
// (internal/machines). The actual resolve-then-check plumbing both
// variants share now lives in internal/netguard (#901 code review) — this
// file keeps only what's genuinely specific to this package's threat model:
// the private/public IP predicate and the lookupIPAddr test seam.

// lookupIPAddr is a package-level var (not a bare net.DefaultResolver call)
// so tests can substitute a fake resolver instead of depending on real DNS
// or real private/public IP literals being reachable in CI.
var lookupIPAddr = net.DefaultResolver.LookupIPAddr

// assertPublicHost ports ssrf-guard.js's assertPublicHost(hostname), via
// internal/netguard's shared AssertHost + IsPrivateAddress predicate. The
// private/loopback/link-local IP predicate moved to internal/netguard in
// #901's Phase 2c so internal/importer (GET /api/import/url) — same threat
// model — can reuse it without a third copy; see netguard/private.go.
func assertPublicHost(ctx context.Context, hostname string) error {
	return netguard.AssertHost(ctx, hostname, netguard.IsPrivateAddress, lookupIPAddr)
}

// isSSRFBlocked reports whether err is (or wraps) an ErrBlocked from a
// failed assertPublicHost call.
func isSSRFBlocked(err error) bool {
	return netguard.IsBlocked(err)
}
