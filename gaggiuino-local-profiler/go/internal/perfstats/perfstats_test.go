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

func TestRecentWindowDropsOldSamples(t *testing.T) {
	rec := New()
	now := time.Now()
	rec.record("GET /x", now.Add(-20*time.Minute), ms(5))
	rec.record("GET /x", now, ms(7))

	got := findRoute(t, rec.Snapshot(now), "GET /x")
	if got.Count != 2 {
		t.Fatalf("count = %d, want 2", got.Count)
	}
	if got.RecentCount != 1 {
		t.Fatalf("recent_count = %d, want 1 (only the in-window sample)", got.RecentCount)
	}
	if got.RecentMedianMs != 7 || got.RecentMaxMs != 7 {
		t.Fatalf("recent median/max = %v/%v, want 7/7", got.RecentMedianMs, got.RecentMaxMs)
	}
	if got.MedianMs != 6 {
		t.Fatalf("median over both samples = %v, want 6", got.MedianMs)
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
	other := rec.routes[otherRoute]
	realRoutes := 0
	maxRingCount := 0
	for name, rs := range rec.routes {
		if name != otherRoute {
			realRoutes++
			if rs.all.total != requests/patterns {
				t.Fatalf("route %q total = %d, want %d", name, rs.all.total, requests/patterns)
			}
		}
		if rs.all.count > maxRingCount {
			maxRingCount = rs.all.count
		}
		if rs.recent.count > maxRingCount {
			maxRingCount = rs.recent.count
		}
	}
	rec.mu.Unlock()

	if realRoutes != maxRoutes {
		t.Fatalf("tracked real routes = %d, want the cap %d", realRoutes, maxRoutes)
	}
	if total != maxRoutes+1 {
		t.Fatalf("map entries = %d, want %d real plus %q", total, maxRoutes, otherRoute)
	}
	if other == nil {
		t.Fatalf("%q route missing", otherRoute)
	}
	if other.all.total != requests-maxRoutes*(requests/patterns) {
		t.Fatalf("%q total = %d, want the overflow", otherRoute, other.all.total)
	}
	if maxRingCount != ringSize {
		t.Fatalf("largest ring holds %d samples, want the cap %d", maxRingCount, ringSize)
	}
	if other.all.count != ringSize {
		t.Fatalf("overflow ring holds %d samples, want %d", other.all.count, ringSize)
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
