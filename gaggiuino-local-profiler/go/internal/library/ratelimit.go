package library

import (
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// rateLimiter implements a fixed-window limiter: a 60s window per key,
// reset (not slid) once it expires — distinct from internal/ratelimit's
// token-bucket app-level limiter (that one gates every request by socket
// address; this one additionally rate-limits specific library create/scan
// routes by `lib:<ip>`/`scan:<ip>` keys).
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

// gcInterval is the window sweep interval (120s), used both as the sweep
// cadence and (in gc) the cutoff age.
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

// gcLoop is the sweep loop: every rl.interval, drop windows whose entry is
// older than rl.interval. In production nothing stops it — main.go's
// srv.Serve(...) blocks forever with no signal handling or graceful-shutdown
// path, so this goroutine simply lives (and dies) with the process. The
// test-only Stop helper (ratelimit_test.go) lets a test tear it down cleanly
// instead of leaking it.
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

// gc drops windows whose entry is older than the cutoff.
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

// allow applies the per-key count check.
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
