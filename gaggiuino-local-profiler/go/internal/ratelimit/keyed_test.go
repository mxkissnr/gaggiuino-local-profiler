package ratelimit

import (
	"testing"
	"time"
)

// TestKeyedLimiter_WindowAndReset covers the three properties every
// feature-level limiter (card:<ip>, export-db:<ip>, orders:<ip>, …) relies
// on: the limit lets exactly maxPerMinute through, the next call in the
// same window is denied, and the counter resets once the 60s window rolls
// over.
func TestKeyedLimiter_WindowAndReset(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := NewKeyed()
	l.now = func() time.Time { return now }

	const max = 5
	for i := 0; i < max; i++ {
		if !l.Allow("card:1.2.3.4", max) {
			t.Fatalf("request %d denied inside the window, want allowed", i)
		}
	}
	if l.Allow("card:1.2.3.4", max) {
		t.Fatal("request past maxPerMinute allowed, want denied")
	}

	// A different key has its own bucket.
	if !l.Allow("card:5.6.7.8", max) {
		t.Fatal("first request for a fresh key denied, want allowed")
	}

	// Still inside the same window: original key stays denied.
	now = now.Add(59 * time.Second)
	if l.Allow("card:1.2.3.4", max) {
		t.Fatal("request still inside the 60s window allowed, want denied")
	}

	// Past the window: the counter resets.
	now = now.Add(2 * time.Second) // 61s total
	if !l.Allow("card:1.2.3.4", max) {
		t.Fatal("first request after the window rolled over denied, want allowed")
	}
}
