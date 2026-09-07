package library

import (
	"testing"
	"time"
)

// TestRateLimiter_GCDeletesEntriesOlderThanInterval deterministically
// exercises gc()'s cutoff logic (no ticker/timing involved): an entry
// whose window reset happened more than one interval ago is dropped, one
// reset "now" survives.
func TestRateLimiter_GCDeletesEntriesOlderThanInterval(t *testing.T) {
	rl := newRateLimiterWithInterval(time.Hour)
	defer rl.Stop()

	now := time.Now()
	rl.mu.Lock()
	rl.windows["stale"] = &rlWindow{t: now.Add(-2 * time.Hour), n: 5}
	rl.windows["fresh"] = &rlWindow{t: now, n: 1}
	rl.mu.Unlock()

	rl.gc(now)

	rl.mu.Lock()
	_, staleOK := rl.windows["stale"]
	_, freshOK := rl.windows["fresh"]
	rl.mu.Unlock()
	if staleOK {
		t.Fatalf("expected stale window to be deleted by gc")
	}
	if !freshOK {
		t.Fatalf("gc deleted the still-fresh window too")
	}
}

// TestRateLimiter_GCLoopRunsPeriodically guards #901: rl.windows used to
// grow forever because nothing ever swept it. Shortens the GC cadence
// instead of waiting on the real 120s production interval, and only
// asserts on an entry planted far enough in the past (1h) that it's
// unambiguously expired against any cutoff the short interval produces —
// avoiding a "fresh" entry that would itself age past a short interval
// during the poll.
func TestRateLimiter_GCLoopRunsPeriodically(t *testing.T) {
	rl := newRateLimiterWithInterval(10 * time.Millisecond)
	defer rl.Stop()

	rl.mu.Lock()
	rl.windows["stale"] = &rlWindow{t: time.Now().Add(-time.Hour), n: 5}
	rl.mu.Unlock()

	deadline := time.Now().Add(2 * time.Second)
	for {
		rl.mu.Lock()
		_, present := rl.windows["stale"]
		rl.mu.Unlock()
		if !present {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("gc loop did not remove the expired window within the deadline")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestRateLimiter_StopIsIdempotent guards the sync.Once wiring: Stop must
// tolerate being called more than once without panicking (close of a closed
// channel).
func TestRateLimiter_StopIsIdempotent(t *testing.T) {
	rl := newRateLimiterWithInterval(time.Hour)
	rl.Stop()
	rl.Stop()
}
