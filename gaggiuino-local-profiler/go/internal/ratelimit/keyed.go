package ratelimit

import (
	"sync"
	"time"
)

// KeyedLimiter ports lib/helpers.js's rateLimit(key, maxPerMinute): a fixed
// one-minute window counter per arbitrary string key, distinct from
// Limiter's app-wide, socket-address-only token bucket above. Callers pick
// their own key prefix/scope (e.g. orders' "orders:<ip>" for POST
// /api/orders, backup's "restore:<ip>"/"restore-preview:<ip>" for
// POST /api/restore) and their own maxPerMinute per call to Allow — one
// KeyedLimiter instance is shared across every such feature-level limit a
// package needs. Originally duplicated verbatim between
// internal/orders/ratelimit.go and internal/backup/ratelimit.go (#901 code
// review); consolidated here since both domains need the identical
// behavior. Entries older than 2 windows are swept lazily on Allow rather
// than a background ticker (Node's setInterval(...,120_000) has no direct
// equivalent worth adding a goroutine for at this scale).
//
// Most feature-level keys mirror a Node rateLimit() call 1:1 (orders,
// restore, token, library scan/create). Two keys are DELIBERATELY STRICTER
// THAN NODE, added in the Go port only (#999, security audit #977 round 3
// finding 3.2): "card:<ip>" (30/min, internal/shots — resvg-wasm render
// hot-spot) and "export-db:<ip>" (5/min, internal/debug — full-DB stream).
// Node feature-limits neither route, leaving both under the shared 600/min
// backstop alone; the Go rewrite is the moment to tighten them. The IP is
// internal/auth.RemoteIP(r) — the raw socket address, never
// X-Forwarded-For — so behind HA Ingress every browser shares one bucket
// per key (all ingress traffic is one Supervisor source IP); see this
// package's doc.go for why trusting the header would be the worse trade.
type KeyedLimiter struct {
	mu      sync.Mutex
	windows map[string]*keyedWindow

	// now is a test seam; nil means time.Now. Same pattern as
	// internal/debug.Handlers.now.
	now func() time.Time
}

type keyedWindow struct {
	start time.Time
	count int
}

// NewKeyed creates an empty KeyedLimiter.
func NewKeyed() *KeyedLimiter {
	return &KeyedLimiter{windows: make(map[string]*keyedWindow)}
}

// Allow ports rateLimit(key, maxPerMinute): increments key's counter,
// resetting it if more than 60s have elapsed since the window started, and
// reports whether the incremented count is still within maxPerMinute.
func (l *KeyedLimiter) Allow(key string, maxPerMinute int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.now != nil {
		now = l.now()
	}
	w, ok := l.windows[key]
	if !ok || now.Sub(w.start) > time.Minute {
		w = &keyedWindow{start: now}
		l.windows[key] = w
	}
	w.count++
	if len(l.windows) > 10000 {
		cutoff := now.Add(-2 * time.Minute)
		for k, v := range l.windows {
			if v.start.Before(cutoff) {
				delete(l.windows, k)
			}
		}
	}
	return w.count <= maxPerMinute
}
