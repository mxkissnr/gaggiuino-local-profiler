package perfstats

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func TestQuantilesKnownDurations(t *testing.T) {
	// 1..100 ms: even count, the median averages the two middles and the
	// nearest-rank p95 is the 95th value.
	var hundred []time.Duration
	for i := 1; i <= 100; i++ {
		hundred = append(hundred, ms(i))
	}
	median, p95 := quantiles(hundred)
	if want := ms(50) + time.Millisecond/2; median != want {
		t.Fatalf("median of 1..100ms = %v, want %v", median, want)
	}
	if want := ms(95); p95 != want {
		t.Fatalf("p95 of 1..100ms = %v, want %v", p95, want)
	}

	// Odd count: the median is the middle value; p95 rounds up to the max.
	median, p95 = quantiles([]time.Duration{ms(3), ms(1), ms(2)})
	if median != ms(2) {
		t.Fatalf("median of [3,1,2]ms = %v, want 2ms", median)
	}
	if p95 != ms(3) {
		t.Fatalf("p95 of [3,1,2]ms = %v, want 3ms", p95)
	}

	// Empty input is all zeroes.
	if median, p95 = quantiles(nil); median != 0 || p95 != 0 {
		t.Fatalf("quantiles(nil) = %v, %v, want 0, 0", median, p95)
	}
}

func TestRoutePatternNotRawPath(t *testing.T) {
	rec := New()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/shots/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/shots/42?x=1", nil)
	rec.Middleware(mux).ServeHTTP(httptest.NewRecorder(), req)

	snap := rec.Snapshot(time.Now())
	if len(snap.Routes) != 1 {
		t.Fatalf("routes = %d, want 1: %+v", len(snap.Routes), snap.Routes)
	}
	got := snap.Routes[0]
	if got.Route != "GET /api/shots/{id}" {
		t.Fatalf("route key = %q, want the pattern %q", got.Route, "GET /api/shots/{id}")
	}
	if got.Count != 1 {
		t.Fatalf("count = %d, want 1", got.Count)
	}
	// The raw id and query must never appear in a key.
	for _, r := range snap.Routes {
		if strings.Contains(r.Route, "42") || strings.Contains(r.Route, "x=1") {
			t.Fatalf("raw path or query leaked into the route key: %q", r.Route)
		}
	}
}

func TestUnmatchedRequestRecorded(t *testing.T) {
	rec := New()
	mux := http.NewServeMux() // No patterns: every request is unmatched.
	req := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	rec.Middleware(mux).ServeHTTP(httptest.NewRecorder(), req)

	snap := rec.Snapshot(time.Now())
	if len(snap.Routes) != 1 {
		t.Fatalf("routes = %d, want 1", len(snap.Routes))
	}
	if snap.Routes[0].Route != unmatchedRoute {
		t.Fatalf("route key = %q, want %q", snap.Routes[0].Route, unmatchedRoute)
	}
}

func TestRecentQuantilesIgnoreOldSamples(t *testing.T) {
	rec := New()
	now := time.Now()
	// Two samples far outside the window and two inside it. The since-start
	// counters see all four, but the recent median/p95/max must use only the two
	// in-window samples.
	rec.record("GET /x", now.Add(-20*time.Minute), ms(500))
	rec.record("GET /x", now.Add(-20*time.Minute), ms(500))
	rec.record("GET /x", now.Add(-time.Minute), ms(4))
	rec.record("GET /x", now.Add(-time.Minute), ms(6))

	got := findRoute(t, rec.Snapshot(now), "GET /x")
	if got.Count != 4 {
		t.Fatalf("count = %d, want 4", got.Count)
	}
	if got.MaxMs != 500 {
		t.Fatalf("since-start max = %v, want 500", got.MaxMs)
	}
	if got.RecentCount != 2 {
		t.Fatalf("recent_count = %d, want 2", got.RecentCount)
	}
	if got.RecentMedianMs != 5 {
		t.Fatalf("recent median = %v, want 5", got.RecentMedianMs)
	}
	if got.RecentP95Ms != 6 {
		t.Fatalf("recent p95 = %v, want 6", got.RecentP95Ms)
	}
	if got.RecentMaxMs != 6 {
		t.Fatalf("recent max = %v, want 6", got.RecentMaxMs)
	}
}

func TestRoutesAndRingsStayBounded(t *testing.T) {
	rec := New()
	now := time.Now()
	const (
		requests = 100_000
		patterns = 1_000
	)
	for i := 0; i < requests; i++ {
		rec.record(fmt.Sprintf("GET /api/p%d", i%patterns), now, time.Duration(i%13)*time.Millisecond)
	}

	rec.mu.Lock()
	total := len(rec.routes)
	otherTotal := int64(-1)
	otherRingCount := -1
	realRoutes := 0
	maxRingCount := 0
	for name, rs := range rec.routes {
		if name != otherRoute {
			realRoutes++
			if rs.ring.total != requests/patterns {
				t.Fatalf("route %q total = %d, want %d", name, rs.ring.total, requests/patterns)
			}
		} else {
			otherTotal = rs.ring.total
			otherRingCount = rs.ring.count
		}
		if rs.ring.count > maxRingCount {
			maxRingCount = rs.ring.count
		}
	}
	rec.mu.Unlock()

	if realRoutes != maxRoutes {
		t.Fatalf("tracked real routes = %d, want the cap %d", realRoutes, maxRoutes)
	}
	if total != maxRoutes+1 {
		t.Fatalf("map entries = %d, want %d real plus %q", total, maxRoutes, otherRoute)
	}
	if otherTotal != requests-maxRoutes*(requests/patterns) {
		t.Fatalf("%q total = %d, want the overflow", otherRoute, otherTotal)
	}
	if maxRingCount != ringSize {
		t.Fatalf("largest ring holds %d samples, want the cap %d", maxRingCount, ringSize)
	}
	if otherRingCount != ringSize {
		t.Fatalf("overflow ring holds %d samples, want %d", otherRingCount, ringSize)
	}
}

func TestSnapshotSortedByCountThenRoute(t *testing.T) {
	rec := New()
	now := time.Now()
	for i := 0; i < 3; i++ {
		rec.record("GET /b", now, ms(1))
	}
	rec.record("GET /a", now, ms(1))
	rec.record("GET /c", now, ms(1))
	rec.record("GET /c", now, ms(1))

	snap := rec.Snapshot(now)
	var order []string
	for _, r := range snap.Routes {
		order = append(order, r.Route)
	}
	// /b and /c both have two; the tie breaks by route name, /b before /c.
	want := "GET /b,GET /c,GET /a"
	if got := strings.Join(order, ","); got != want {
		t.Fatalf("route order = %v, want %v", got, want)
	}
	if snap.Process.Goroutines < 1 {
		t.Fatalf("goroutines = %d, want at least 1", snap.Process.Goroutines)
	}
}

func TestRecorderConcurrentUse(t *testing.T) {
	rec := New()
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func(g int) {
			defer func() { done <- struct{}{} }()
			now := time.Now()
			for i := 0; i < 1000; i++ {
				rec.record(fmt.Sprintf("GET /g%d/p%d", g%2, i%8), now, ms(i%5))
			}
		}(g)
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	if len(rec.Snapshot(time.Now()).Routes) == 0 {
		t.Fatalf("no routes recorded")
	}
}

func TestRecentCountExactPastRingSize(t *testing.T) {
	rec := New()
	now := time.Now()
	// 900 requests scattered over the window: more than the ring can hold, so
	// recent_count must come from the per-minute buckets rather than the ring.
	for i := 0; i < 900; i++ {
		rec.record("GET /x", now.Add(-time.Duration(i%14)*time.Minute), ms(1))
	}
	got := findRoute(t, rec.Snapshot(now), "GET /x")
	if got.Count != 900 {
		t.Fatalf("count = %d, want 900", got.Count)
	}
	if got.RecentCount != 900 {
		t.Fatalf("recent_count = %d, want 900 (not capped at the ring size %d)", got.RecentCount, ringSize)
	}
}

func TestHeadRequestKeepsExistingMethodPattern(t *testing.T) {
	rec := New()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /x", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodHead, "/x", nil)
	rec.Middleware(mux).ServeHTTP(httptest.NewRecorder(), req)

	snap := rec.Snapshot(time.Now())
	if len(snap.Routes) != 1 {
		t.Fatalf("routes = %d, want 1: %+v", len(snap.Routes), snap.Routes)
	}
	if got := snap.Routes[0].Route; got != "GET /x" {
		t.Fatalf("HEAD request key = %q, want the pattern %q", got, "GET /x")
	}
}

func TestBarePatternKeyedByMethod(t *testing.T) {
	rec := New()
	mux := http.NewServeMux()
	mux.HandleFunc("/x", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec.Middleware(mux).ServeHTTP(httptest.NewRecorder(), req)

	snap := rec.Snapshot(time.Now())
	if len(snap.Routes) != 1 {
		t.Fatalf("routes = %d, want 1: %+v", len(snap.Routes), snap.Routes)
	}
	if got := snap.Routes[0].Route; got != "GET /x" {
		t.Fatalf("bare-path key = %q, want %q", got, "GET /x")
	}
}

func TestSSEStreamNotRecordedButStillFlushes(t *testing.T) {
	rec := New()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /stream", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("middleware response writer does not implement http.Flusher")
			return
		}
		f.Flush()
	})

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	rec.Middleware(mux).ServeHTTP(rr, req)

	if !rr.Flushed {
		t.Fatalf("stream did not flush through the middleware")
	}
	if routes := rec.Snapshot(time.Now()).Routes; len(routes) != 0 {
		t.Fatalf("SSE stream was recorded: %+v", routes)
	}
}

func findRoute(t *testing.T, snap Snapshot, name string) RouteSnapshot {
	t.Helper()
	for _, r := range snap.Routes {
		if r.Route == name {
			return r
		}
	}
	t.Fatalf("route %q not found in %+v", name, snap.Routes)
	return RouteSnapshot{}
}
