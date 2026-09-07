package library

import (
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// rateLimiter ports lib/helpers.js's rateLimit(key, maxPerMinute): a fixed
// 60s window per key, reset (not slid) once it expires — distinct from
// internal/ratelimit's token-bucket app-level limiter (that one gates every
// request by socket address; this one additionally rate-limits specific
// library create/scan routes by `lib:<ip>`/`scan:<ip>` keys, exactly
// mirroring the Node original's own second, route-scoped limiter).
type rateLimiter struct {
	mu       sync.Mutex
	windows  map[string]*rlWindow
	interval time.Duration
	stop     chan struct{}
	stopOnce sync.Once
}

type rlWindow struct {
	t time.Time
	n int
}

// gcInterval ports lib/helpers.js's `setInterval(..., 120_000)` — the same
// 120s value is used both as the sweep cadence and (in gc) the cutoff age.
const gcInterval = 120 * time.Second

func newRateLimiter() *rateLimiter {
	return newRateLimiterWithInterval(gcInterval)
}

// newRateLimiterWithInterval lets tests shrink the GC cadence instead of
// waiting on the real 120s production interval.
func newRateLimiterWithInterval(interval time.Duration) *rateLimiter {
	rl := &rateLimiter{windows: make(map[string]*rlWindow), interval: interval, stop: make(chan struct{})}
	httputil.SafeGo("library: ratelimit gc", rl.gcLoop)
	return rl
}

// gcLoop ports lib/helpers.js's setInterval body: every rl.interval, drop
// windows whose entry is older than rl.interval. Nothing in cmd/server
// calls Stop() today — main.go's srv.Serve(...) blocks forever with no
// signal handling or graceful-shutdown path yet, so in production this
// goroutine simply lives (and dies) with the process, same as the Node
// original's setInterval timer did. Stop exists so tests, and a future
// shutdown path, can tear it down cleanly instead of leaking it.
func (rl *rateLimiter) gcLoop() {
	ticker := time.NewTicker(rl.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			rl.gc(time.Now())
		case <-rl.stop:
			return
		}
	}
}

// gc ports `for (const [k, v] of _rlWindows) { if (v.t < cutoff) delete }`.
func (rl *rateLimiter) gc(now time.Time) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := now.Add(-rl.interval)
	for k, e := range rl.windows {
		if e.t.Before(cutoff) {
			delete(rl.windows, k)
		}
	}
}

// Stop terminates the background GC goroutine. Safe to call more than once.
func (rl *rateLimiter) Stop() {
	rl.stopOnce.Do(func() { close(rl.stop) })
}

// allow ports the `++e.n <= maxPerMinute` check.
func (rl *rateLimiter) allow(key string, maxPerMinute int) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	e, ok := rl.windows[key]
	if !ok || now.Sub(e.t) > 60*time.Second {
		e = &rlWindow{t: now, n: 0}
		rl.windows[key] = e
	}
	e.n++
	return e.n <= maxPerMinute
}
