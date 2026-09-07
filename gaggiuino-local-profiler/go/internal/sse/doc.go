// Package sse is the Go port of routes/sse.js — the single /api/events
// Server-Sent Events endpoint multiplexing sync-progress, sync-complete,
// live-snapshot and preheat-update pushes over one connection (see the
// Event* constants in sse.go for the exact set; lib/events.js's other four
// event types — shot-saved/bean-changed/maintenance-acknowledged/
// order-completed, plus profile-saved/backup-exported — feed only
// AchievementService, never this endpoint, and are out of scope here).
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
// One documented divergence: routes/sse.js explicitly calls
// res.socket?.setNoDelay?.(true) (#740) because Node's net.Socket defaults
// Nagle's algorithm ON. Go's net.TCPConn defaults it OFF (NoDelay=true)
// already — see net.TCPConn.SetNoDelay's doc comment — so there is no
// equivalent call to make here. cmd/server still wraps its listener to make
// that guarantee explicit and future-proof (see its own comment), but that
// is defense-in-depth, not a port of routes/sse.js's workaround, which this
// package therefore correctly has no code for.
//
// The ?token= query-param auth fallback for EventSource does NOT live in
// this package, matching routes/sse.js having no auth logic of its own —
// it's a special case in internal/auth.RequireToken (checked only when the
// request path is /api/events), which cmd/server wires this package's
// handler behind unchanged rather than this package reimplementing it.
//
// Hub is the Go port of lib/events.js's `bus` EventEmitter: a minimal
// in-process pub/sub. Phase 1c's domain packages (sync, preheat, poll) are
// the intended producers via Hub.Publish/Handler.Prime; neither exists yet,
// so cmd/server currently wires this package up with no real producer, only
// the endpoint itself and its own connect/priming/keepalive/multiplexing
// mechanics — verified by sse_test.go's placeholder Publish/Prime calls.
package sse
