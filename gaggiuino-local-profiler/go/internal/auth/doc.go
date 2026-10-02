// Package auth implements the app's ingress-trust and token-auth model:
//
//   - IsFromSupervisor/IsIngressRequest trust the HA Supervisor's
//     172.30.0.0/16 add-on network (plus loopback), and require both a
//     Supervisor-network source IP and an X-Ingress-Path header with the
//     HAIngressPrefix prefix before a request counts as genuine Ingress.
//   - IsTokenValid is a constant-time X-GLP-Token comparison
//     (crypto/subtle.ConstantTimeCompare), including the same-length-
//     required early exit.
//   - LoadOrCreateToken reads or generates-and-persists the token against
//     /data/api_token.txt (DefaultTokenFile), using a tmp-file-then-rename
//     atomic write.
//   - SecurityHeaders is the security-header net/http middleware.
//   - RequireToken is the API-token-auth middleware: the X-GLP-Token header
//     / ?token= query-param (for /api/events only) checks, the Ingress/
//     status/token/non-API bypasses, and the JSON 401/503 error shapes, in
//     that order.
//
// See go/README.md for the security guarantees this model must preserve.
//
// The per-socket-address rate-limit bucket logic is NOT part of this
// package — it lives in the sibling internal/ratelimit package, which
// reuses this package's RemoteIP for its bucket key.
package auth
