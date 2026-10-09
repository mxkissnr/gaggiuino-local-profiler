// Package sse implements the single /api/events Server-Sent Events endpoint
// multiplexing live-snapshot and preheat-update pushes over one connection
// (see the Event* constants in sse.go for the exact set), plus the
// data-changed push (see datachanged.go and EventDataChanged). The older
// per-domain event types — shot-saved/bean-changed/maintenance-acknowledged/
// order-completed, plus profile-saved/backup-exported — stay retired (#1200):
// one data-changed event naming a kind replaces them.
//
// The documented HA-Ingress-buffering workarounds are replicated exactly,
// not approximated — see project_glp_sse_ingress_nginx_buffering in the
// operator's memory for why: this broke Live View in production once
// already.
//
//   - Leading 2048-byte padding comment line, written before anything else.
//   - X-Accel-Buffering: no.
//   - 20-second :ping keepalive comment line (PingInterval).
//   - Connect-time priming: whatever state is already available is sent
//     immediately, before subscribing to future events, so a client that
//     connects mid-backfill/mid-brew doesn't wait for the next push to see
//     where things stand.
//
// No explicit setNoDelay(true) call is needed (#740): Go's net.TCPConn
// defaults Nagle's algorithm OFF (NoDelay=true) already — see
// net.TCPConn.SetNoDelay's doc comment. cmd/server still wraps its listener
// to make that guarantee explicit and future-proof (see its own comment);
// that is defense-in-depth, not something this package needs, so it
// correctly has no code for it.
//
// The ?token= query-param auth fallback for EventSource does NOT live in
// this package — it's a special case in internal/auth.RequireToken (checked
// only when the request path is /api/events), which cmd/server wires this
// package's handler behind unchanged rather than this package reimplementing
// it.
//
// Hub is a minimal in-process pub/sub. Producers publish through
// Hub.Publish/Handler.Prime; cmd/server wires DataChanges (datachanged.go) as
// the data-changed producer and the poller as the prime/live-snapshot
// producer. The endpoint's own connect/priming/keepalive/multiplexing
// mechanics are verified by sse_test.go.
package sse
