package netguard

import (
	"context"
	"net"
)

// GuardedDialer pins an outbound TCP dial to the IP a resolve-and-check
// guard just approved for the requested hostname, instead of handing the
// raw hostname to a dialer that would re-resolve it independently at
// connect time (#987's DNS-rebinding TOCTOU — see AssertHostResolved's doc
// comment for the full rationale). This was previously duplicated verbatim
// between internal/machines/http.go and internal/importer/fetch.go
// (#990 code review); both now construct one of these instead.
type GuardedDialer struct {
	// Resolve returns the approved IP for hostname (or an error if the
	// guard rejects it) — typically a package's own AssertHostResolved-
	// backed wrapper, so a resolve-time test seam that package already has
	// (e.g. a swappable guard var) is honored on every dial. Required.
	Resolve func(ctx context.Context, hostname string) (net.IP, error)

	// Dial performs the actual connection to the pinned ip:port. Defaults
	// to (&net.Dialer{}).DialContext via NewGuardedDialer. A test that
	// wants to observe or stub the dial constructs its own GuardedDialer
	// with its own Dial func instead of mutating a shared instance — so
	// this field never needs to be swapped concurrently with production
	// use.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

// NewGuardedDialer returns a GuardedDialer that dials with a real
// net.Dialer by default.
func NewGuardedDialer(resolve func(ctx context.Context, hostname string) (net.IP, error)) *GuardedDialer {
	return &GuardedDialer{Resolve: resolve, Dial: (&net.Dialer{}).DialContext}
}

// DialContext is an http.Transport.DialContext-compatible function (and,
// via a small adapter, works anywhere else a "dial this host:port" func is
// needed — e.g. mqtt/client.go's paho CustomOpenConnectionFn). The
// caller's URL/Host header (or, for MQTT, the broker URI) keeps the
// original hostname unchanged — this only controls the wire-level TCP
// target, so TLS SNI/certificate validation for an https:// host is
// unaffected.
func (g *GuardedDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ip, err := g.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	return g.Dial(ctx, network, net.JoinHostPort(ip.String(), port))
}
