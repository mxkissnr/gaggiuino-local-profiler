// Package netguard holds the SSRF-guard machinery lib/ssrf-guard.js's
// shared `_assertHostPasses` helper implements once in Node: resolve a
// hostname (or accept a literal IP), then reject it if any resolved
// address matches a caller-supplied "blocked" predicate. internal/library's
// assertPublicHost (blocks private/loopback/link-local — used against
// untrusted external hosts) and internal/machines's assertMachineHost
// (blocks only loopback/link-local/cloud-metadata — used against the app
// owner's own trusted LAN machines, which legitimately live in RFC1918
// space, #336) are two different threat models with two different
// predicates, but the resolve-then-check plumbing around them was, until
// #901's code review, copy-pasted verbatim between internal/library/ssrf.go
// and internal/machines/ssrf.go — a security boundary drifting apart across
// two independently-maintained copies is exactly the kind of risk this
// package exists to remove. Each importing package keeps its own
// package-level `lookupIPAddr` var (their existing test seam, unchanged)
// and its own domain-specific blocked-IP predicate, and calls AssertHost
// with both.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
)

// ErrBlocked is returned by AssertHost when blocked matches a resolved (or
// literal) address. Each importing package defines its own local
// isSSRFBlocked(err) that forwards to IsBlocked, so callers outside this
// package never need to import it directly.
type ErrBlocked struct{ msg string }

func (e *ErrBlocked) Error() string { return e.msg }

// IsBlocked reports whether err is (or wraps) an *ErrBlocked.
func IsBlocked(err error) bool {
	var e *ErrBlocked
	return errors.As(err, &e)
}

// AssertHost resolves hostname via lookupIPAddr (or, for a literal IP,
// parses it directly without a DNS round-trip — same as the Node
// original), and returns an *ErrBlocked if blocked reports true for any
// resolved address. A resolution failure is returned as a plain (non-
// ErrBlocked) error, matching both callers' existing distinction between
// "blocked by policy" and "just couldn't resolve."
func AssertHost(ctx context.Context, hostname string, blocked func(net.IP) bool, lookupIPAddr func(context.Context, string) ([]net.IPAddr, error)) error {
	_, err := AssertHostResolved(ctx, hostname, blocked, lookupIPAddr)
	return err
}

// AssertHostResolved is AssertHost's pin-friendly counterpart (#987): same
// resolve-then-check plumbing, but it also returns the resolved (or
// literal) address that passed the check. A caller that goes on to open a
// real connection should dial that exact IP instead of handing the
// hostname to net/http's (or any other) dialer to resolve a second time —
// resolving once here and reusing the answer closes the DNS-rebinding
// window where an attacker's resolver could pass this check with a safe
// address and then answer a second, independent lookup at connect time
// with a blocked one instead.
func AssertHostResolved(ctx context.Context, hostname string, blocked func(net.IP) bool, lookupIPAddr func(context.Context, string) ([]net.IPAddr, error)) (net.IP, error) {
	bare := strings.TrimPrefix(strings.TrimSuffix(hostname, "]"), "[")
	if ip := net.ParseIP(bare); ip != nil {
		if blocked(ip) {
			return nil, &ErrBlocked{fmt.Sprintf("blocked address: %s", bare)}
		}
		return ip, nil
	}
	addrs, err := lookupIPAddr(ctx, bare)
	if err != nil {
		return nil, fmt.Errorf("could not resolve host: %s: %w", bare, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("could not resolve host: %s", bare)
	}
	for _, a := range addrs {
		if blocked(a.IP) {
			return nil, &ErrBlocked{fmt.Sprintf("blocked address: %s (%s)", a.IP, bare)}
		}
	}
	return addrs[0].IP, nil
}
