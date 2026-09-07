// Package ratelimit is the Go port of lib/middleware/rateLimit.js's
// app-level rate limiter (server.js's app.use(createApiRateLimiter())):
// a light-touch backstop against a runaway client or bug, not a real abuse
// defense — see that file's own comment for the traffic budget 600 req/min
// was sized against.
//
// Two deliberate carry-overs from the Node original, not oversights:
//
//   - The bucket key is the raw socket address only (internal/auth.RemoteIP)
//     — never X-Forwarded-For — because server.js never calls
//     app.set('trust proxy', ...) either, so trusting a client-supplied
//     header here would let a LAN client hitting the exposed port spoof its
//     own key and dodge the limit, the same header-spoofing concern
//     internal/auth's ingress-trust checks exist for. Before use as a key,
//     an IPv6 address is masked to its /64 network prefix (bucketKey in
//     ratelimit.go) — the same default express-rate-limit's ipKeyGenerator
//     applies — so a client with a routed /64 (or larger) IPv6 allocation
//     can't dodge the limit by presenting a fresh address from that block
//     on every request; IPv4 addresses are used exactly as received, one
//     bucket per address, matching the Node original.
//   - /assets/* (the content-hashed Vite bundle) never counts against the
//     budget.
//
// Algorithm difference, not a behavior gap: express-rate-limit uses a fixed
// window counter (up to Max requests in each Window, then a hard stop until
// the window rolls over); Limiter here uses golang.org/x/time/rate's
// token-bucket instead (continuous refill up to Max tokens per Window, with
// an initial full-Max burst) per this package's own dispatch instructions.
// Both land on the same effective ceiling — Max requests per Window,
// sustained — which is all this backstop actually needs to guarantee.
package ratelimit
