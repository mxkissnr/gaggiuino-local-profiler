package shots

import (
	"net/http"
	"runtime"
	"sort"
	"sync"
	"testing"
	"time"
)

// TestDefaultResvgPoolSize pins the #980 floor/cap: the pool tracks
// GOMAXPROCS so a host doesn't pay RSS for slots it can't run in parallel,
// but never drops below 2 (the pre-#980 default, and #956's RSS budget)
// or above 4 (typical add-on hardware, beyond which the RSS cost stops
// buying real throughput — see the defaultResvgPoolSize doc comment).
func TestDefaultResvgPoolSize(t *testing.T) {
	cases := []struct{ gomaxprocs, want int }{
		{1, 2},
		{2, 2},
		{3, 3},
		{4, 4},
		{5, 4}, {8, 4}, {64, 4},
	}
	prev := runtime.GOMAXPROCS(0)
	defer runtime.GOMAXPROCS(prev)
	for _, c := range cases {
		// GOMAXPROCS(n) requires n >= 1 to actually change the setting
		// (n <= 0 is a read-only no-op per the stdlib doc), which is why
		// defaultResvgPoolSize's own floor only needs to handle >= 1 here.
		runtime.GOMAXPROCS(c.gomaxprocs)
		if got := defaultResvgPoolSize(); got != c.want {
			t.Errorf("GOMAXPROCS(%d): defaultResvgPoolSize() = %d, want %d", c.gomaxprocs, got, c.want)
		}
	}
}

// card_perf_test.go covers the GET /api/shots/{id}/card pooling work from
// #951: concurrent card renders must actually run in parallel (independent
// resvg wasm contexts) rather than serialise behind one global mutex, and
// every concurrent render must still produce a valid, correctly-sized PNG.

// TestGetCard_ConcurrentRendersValid fires c card renders at once and
// checks they all succeed with a well-formed PNG of the right size — the
// pooled resvg contexts must be safe under concurrency (the -race build of
// this test is the real guard). Wall/p50 timing is logged, not asserted:
// it depends heavily on host core count and is dominated by -race
// instrumentation under the CI race gate. The parallel-throughput win is
// covered by BenchmarkCardRenderConcurrent vs BenchmarkCardRenderWarm.
func TestGetCard_ConcurrentRendersValid(t *testing.T) {
	if testing.Short() {
		t.Skip("resvg wasm warm-up is slow; skipped under -short")
	}
	h, _, sqlDB := newTestHandlers(t)
	h.SetCardDeps(
		func() string { return InstallCodeFor("test-install") },
		func(string) string { return "CO" },
	)
	mux := newMux(h)
	dur := int64(280)
	insertShot(t, sqlDB, 7, 1_700_000_000, &dur, "Turbo Shot", cardShotData(), nil)

	// Warm the pool + measure one render on its own.
	start := time.Now()
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/7/card", nil); rec.Code != http.StatusOK {
		t.Fatalf("warm-up render: status %d", rec.Code)
	}
	// A couple more to warm every pool slot.
	for i := 0; i < resvgPoolSize; i++ {
		doJSON(t, mux, http.MethodGet, "/api/shots/7/card", nil)
	}
	singleStart := time.Now()
	doJSON(t, mux, http.MethodGet, "/api/shots/7/card", nil)
	single := time.Since(singleStart)
	t.Logf("warm-up total %v, single warm render %v", time.Since(start), single)

	const c = 10
	durations := make([]time.Duration, c)
	var wg sync.WaitGroup
	wallStart := time.Now()
	for i := 0; i < c; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := time.Now()
			rec := doJSON(t, mux, http.MethodGet, "/api/shots/7/card", nil)
			durations[i] = time.Since(s)
			if rec.Code != http.StatusOK {
				t.Errorf("render %d: status %d", i, rec.Code)
				return
			}
			if w, hgt := decodePNG(t, rec.Body.Bytes()); w != 1080 || hgt != 1080 {
				t.Errorf("render %d: %dx%d, want 1080x1080", i, w, hgt)
			}
		}(i)
	}
	wg.Wait()
	wall := time.Since(wallStart)

	sort.Slice(durations, func(a, b int) bool { return durations[a] < durations[b] })
	p50 := durations[c/2]
	t.Logf("c=%d: wall %v, per-request p50 %v, max %v (single warm render %v)",
		c, wall, p50, durations[c-1], single)
}

// BenchmarkCardRenderWarm measures a single render against an already-warm
// pool slot (no NewRenderer / LoadFontData / SetFontFamily on the path).
func BenchmarkCardRenderWarm(b *testing.B) {
	h, _, sqlDB := newTestHandlers(b)
	h.SetCardDeps(func() string { return "AAAA-AAAA" }, func(string) string { return "CO" })
	mux := newMux(h)
	dur := int64(280)
	insertShot(b, sqlDB, 7, 1_700_000_000, &dur, "Turbo Shot", cardShotData(), nil)
	for i := 0; i < resvgPoolSize+1; i++ {
		doJSON(b, mux, http.MethodGet, "/api/shots/7/card", nil)
	}
	defer withUnlimitedCardRate()()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if rec := doJSON(b, mux, http.MethodGet, "/api/shots/7/card", nil); rec.Code != http.StatusOK {
			b.Fatalf("status %d", rec.Code)
		}
	}
}

// withUnlimitedCardRate lifts the card:<ip> feature limit (#999) for the
// duration of a benchmark and returns a restore func.
func withUnlimitedCardRate() func() {
	prev := cardRateLimitPerMin
	cardRateLimitPerMin = 1 << 30
	return func() { cardRateLimitPerMin = prev }
}

func BenchmarkCardRenderConcurrent(b *testing.B) {
	h, _, sqlDB := newTestHandlers(b)
	h.SetCardDeps(func() string { return "AAAA-AAAA" }, func(string) string { return "CO" })
	mux := newMux(h)
	dur := int64(280)
	insertShot(b, sqlDB, 7, 1_700_000_000, &dur, "Turbo Shot", cardShotData(), nil)
	// warm all slots
	for i := 0; i < resvgPoolSize+1; i++ {
		doJSON(b, mux, http.MethodGet, "/api/shots/7/card", nil)
	}

	defer withUnlimitedCardRate()()

	b.ResetTimer()
	b.SetParallelism(10)
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			rec := doJSON(b, mux, http.MethodGet, "/api/shots/7/card", nil)
			if rec.Code != http.StatusOK {
				b.Fatalf("status %d", rec.Code)
			}
		}
	})
}
