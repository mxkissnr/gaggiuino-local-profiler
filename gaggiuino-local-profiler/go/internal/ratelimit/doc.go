// Package ratelimit provides the app-level rate limiter: a light-touch
// backstop against a runaway client or bug, not a real abuse defense, sized
// against a 600 req/min budget.
//
// Two deliberate behaviors, not oversights:
//
//   - The bucket key is the raw socket address only (internal/auth.RemoteIP)
//     for non-Ingress requests — never X-Forwarded-For — because trusting a
//     client-supplied header here would let a LAN client hitting the exposed
//     port spoof its own key and dodge the limit, the same header-spoofing
//     concern internal/auth's ingress-trust checks exist for. Requests that
//     auth.IsIngressRequest accepts and that carry a valid X-Remote-User-Id
//     (1-64 printable ASCII bytes) are keyed per Home Assistant user instead
//     (`ingress-user:<id>`), so several people using the app through Ingress
//     no longer share one bucket; without that header they fall back to the
//     shared Supervisor address, exactly as before. Before use as a key, an
//     IPv6 address is masked to its /64 network prefix (bucketKey in
//     ratelimit.go) — the usual /64 normalization for IPv6 rate-limit keys —
//     so a client with a routed /64 (or larger) IPv6 allocation can't dodge
//     the limit by presenting a fresh address from that block on every
//     request; IPv4 addresses are used exactly as received, one bucket per
//     address.
//   - /assets/* (the content-hashed SPA bundle) never counts against the
//     budget.
//
// Algorithm difference, not a behavior gap: a fixed window counter allows up
// to Max requests in each Window, then a hard stop until the window rolls
// over; Limiter here uses golang.org/x/time/rate's token-bucket instead
// (continuous refill up to Max tokens per Window, with an initial full-Max
// burst). Both land on the same effective ceiling — Max requests per Window,
// sustained — which is all this backstop actually needs to guarantee.
package ratelimit
