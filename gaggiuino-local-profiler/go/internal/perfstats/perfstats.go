// Package perfstats keeps bounded, in-memory request timings for the
// get_perf_stats developer MCP tool. A Recorder wraps the app's mux as the
// innermost middleware, so it reads the route pattern net/http's ServeMux
// filled in on the request it just served — never the raw path or query
// string. Memory stays bounded no matter how much traffic arrives: each route
// keeps one ring of a fixed number of samples plus a fixed array of per-minute
// buckets, and the number of tracked routes is capped.
//
// The package deliberately depends on nothing but net/http and the runtime:
// no HTTP routing library and no MCP import, so the recorder stays a plain
// observation point.
package perfstats

import (
	"math"
	"net/http"
	"runtime"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// ringSize is how many of a route's latest durations are kept for the
	// recent median/p95 computation. The ring's running total and max stay
	// exact over everything since start.
	ringSize = 512
	// recentWindow is the trailing window the Recent fields report.
	recentWindow = 15 * time.Minute
	// recentBuckets is the number of one-minute buckets that give an exact
	// recent request count across recentWindow.
	recentBuckets = int(recentWindow / time.Minute)
	// maxRoutes caps how many distinct route patterns are tracked; further
	// patterns are folded into otherRoute so memory cannot grow without bound.
	maxRoutes = 256
	// unmatchedRoute is the key for a request no mux pattern claimed.
	unmatchedRoute = "unmatched"
	// otherRoute collects patterns beyond maxRoutes.
	otherRoute = "other"
	// sseContentType marks a streaming response: recording one request for a
	// connection that lives for the whole stream would report a huge duration.
	sseContentType = "text/event-stream"
)

// Recorder observes request timings. It is safe for concurrent use.
type Recorder struct {
	start time.Time

	mu     sync.Mutex
	routes map[string]*routeStats
}

type routeStats struct {
	ring   *ring
	recent [recentBuckets]recentBucket
}

// recentBucket is one minute of one route's request count. minute is the Unix
// minute the bucket currently holds; a bucket whose minute no longer matches is
// reset in place before reuse.
type recentBucket struct {
	minute int64
	count  int64
}

// ring is a fixed-size circular buffer of samples plus the running total and
// maximum, so those two stay exact even when the buffer drops older samples.
type ring struct {
	samples []sample
	next    int
	count   int
	total   int64
	max     time.Duration
}

type sample struct {
	at time.Time
	d  time.Duration
}

func newRing() *ring {
	return &ring{samples: make([]sample, ringSize)}
}

func (r *ring) add(at time.Time, d time.Duration) {
	r.samples[r.next] = sample{at: at, d: d}
	r.next = (r.next + 1) % ringSize
	if r.count < ringSize {
		r.count++
	}
	r.total++
	if d > r.max {
		r.max = d
	}
}

// windowStats describes only samples at or after cutoff; older samples are
// dropped here, at read time, so no per-sample timer is needed.
func (r *ring) windowStats(cutoff time.Time) (median, p95, max time.Duration) {
	ds := make([]time.Duration, 0, r.count)
	for i := 0; i < r.count; i++ {
		s := r.samples[i]
		if s.at.Before(cutoff) {
			continue
		}
		ds = append(ds, s.d)
		if s.d > max {
			max = s.d
		}
	}
	median, p95 = quantiles(ds)
	return median, p95, max
}

// ProcessStats is the process-wide half of a Snapshot.
type ProcessStats struct {
	UptimeS        float64 `json:"uptime_s" jsonschema:"seconds since the process started"`
	HeapInuseBytes uint64  `json:"heap_inuse_bytes" jsonschema:"Go heap in use, bytes"`
	SysBytes       uint64  `json:"sys_bytes" jsonschema:"total bytes obtained from the OS"`
	Goroutines     int     `json:"goroutines" jsonschema:"current goroutine count"`
	GCPauseP95Ms   float64 `json:"gc_pause_p95_ms" jsonschema:"95th-percentile GC pause since start, milliseconds"`
}

// RouteSnapshot is one route pattern's timings. Count and MaxMs are exact
// counters over everything since start. The Recent fields describe the last 15
// minutes: RecentCount is exact, while the durations come from the latest
// retained samples.
type RouteSnapshot struct {
	Route          string  `json:"route" jsonschema:"the route pattern, e.g. 'GET /api/shots/{id}'"`
	Count          int64   `json:"count" jsonschema:"requests since start"`
	MaxMs          float64 `json:"max_ms" jsonschema:"slowest request since start, milliseconds"`
	RecentCount    int64   `json:"recent_count" jsonschema:"requests in the last 15 minutes"`
	RecentMedianMs float64 `json:"recent_median_ms" jsonschema:"median duration over the latest samples in the last 15 minutes, milliseconds"`
	RecentP95Ms    float64 `json:"recent_p95_ms" jsonschema:"95th-percentile duration over the latest samples in the last 15 minutes, milliseconds"`
	RecentMaxMs    float64 `json:"recent_max_ms" jsonschema:"slowest retained sample in the last 15 minutes, milliseconds"`
}

// Snapshot is one read of the recorder's state.
type Snapshot struct {
	Routes  []RouteSnapshot `json:"routes" jsonschema:"per-route timings, busiest first"`
	Process ProcessStats    `json:"process" jsonschema:"process resource use"`
}

// New returns a Recorder whose uptime starts now.
func New() *Recorder {
	return &Recorder{start: time.Now(), routes: map[string]*routeStats{}}
}

// Middleware times every request it serves. It reads r.Pattern only after
// next.ServeHTTP returns: net/http's ServeMux sets that field on the very
// request it passes to the handler, and this middleware wraps the mux
// directly, so it observes the matched pattern. An empty pattern (no route
// claimed the request) is recorded as "unmatched"; a raw path is never
// recorded.
//
// A response whose Content-Type is text/event-stream is not recorded: such a
// connection stays open for the whole stream, so its lifetime is not a request
// duration.
func (rec *Recorder) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w}
		next.ServeHTTP(rw, r)
		end := time.Now()
		if strings.HasPrefix(rw.Header().Get("Content-Type"), sseContentType) {
			return
		}
		rec.record(routeKey(r.Method, r.Pattern), end, end.Sub(start))
	})
}

// responseWriter exposes the handler's response headers to the middleware while
// keeping http.Flusher working, so streaming responses still flush.
type responseWriter struct {
	http.ResponseWriter
}

func (w *responseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// routeKey returns the recording key for a request. ServeMux's r.Pattern
// already carries the method when the route was registered with one
// ("GET /api/shots/{id}"), and a HEAD request on such a route must stay under
// that same key, so a pattern that already names a method is used verbatim. A
// bare path pattern ("/api/mcp") gets the request method prepended.
func routeKey(method, pattern string) string {
	if pattern == "" {
		return unmatchedRoute
	}
	if strings.IndexByte(pattern, ' ') >= 0 {
		return pattern
	}
	return method + " " + pattern
}

func (rec *Recorder) record(route string, at time.Time, d time.Duration) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rs, ok := rec.routes[route]
	if !ok && route != otherRoute && len(rec.routes) >= maxRoutes {
		route = otherRoute
		rs, ok = rec.routes[route]
	}
	if !ok {
		rs = &routeStats{ring: newRing()}
		rec.routes[route] = rs
	}
	rs.ring.add(at, d)
	rs.addRecent(at)
}

// addRecent bumps the per-minute bucket for at. Unlike the ring, the buckets
// keep an exact count over the recent window even past ringSize requests.
func (rs *routeStats) addRecent(at time.Time) {
	minute := at.Unix() / 60
	b := &rs.recent[minute%int64(recentBuckets)]
	if b.minute != minute {
		*b = recentBucket{minute: minute}
	}
	b.count++
}

// recentCount sums the buckets still inside the recent window.
func (rs *routeStats) recentCount(now time.Time) int64 {
	cur := now.Unix() / 60
	var n int64
	for i := range rs.recent {
		b := rs.recent[i]
		if b.minute == 0 || b.minute > cur || cur-b.minute >= int64(recentBuckets) {
			continue
		}
		n += b.count
	}
	return n
}

// Snapshot returns the routes sorted by count descending (ties by route name)
// plus the current process stats. now anchors the 15-minute window.
func (rec *Recorder) Snapshot(now time.Time) Snapshot {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	proc := ProcessStats{
		UptimeS:        now.Sub(rec.start).Seconds(),
		HeapInuseBytes: ms.HeapInuse,
		SysBytes:       ms.Sys,
		Goroutines:     runtime.NumGoroutine(),
		GCPauseP95Ms:   gcPauseP95Ms(),
	}

	cutoff := now.Add(-recentWindow)
	rec.mu.Lock()
	routes := make([]RouteSnapshot, 0, len(rec.routes))
	for name, rs := range rec.routes {
		recentMedian, recentP95, recentMax := rs.ring.windowStats(cutoff)
		routes = append(routes, RouteSnapshot{
			Route:          name,
			Count:          rs.ring.total,
			MaxMs:          toMillis(rs.ring.max),
			RecentCount:    rs.recentCount(now),
			RecentMedianMs: toMillis(recentMedian),
			RecentP95Ms:    toMillis(recentP95),
			RecentMaxMs:    toMillis(recentMax),
		})
	}
	rec.mu.Unlock()

	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Count != routes[j].Count {
			return routes[i].Count > routes[j].Count
		}
		return routes[i].Route < routes[j].Route
	})
	return Snapshot{Routes: routes, Process: proc}
}

// quantiles returns the median and nearest-rank 95th percentile of durations.
// An empty set is all zeroes.
func quantiles(durations []time.Duration) (median, p95 time.Duration) {
	if len(durations) == 0 {
		return 0, 0
	}
	ds := make([]time.Duration, len(durations))
	copy(ds, durations)
	sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
	n := len(ds)
	if n%2 == 1 {
		median = ds[n/2]
	} else {
		median = (ds[n/2-1] + ds[n/2]) / 2
	}
	idx := int(math.Ceil(0.95*float64(n))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= n {
		idx = n - 1
	}
	return median, ds[idx]
}

// gcPauseP95Ms reads the runtime's GC pause quantiles; 101 quantiles make
// index 95 the 95th percentile.
func gcPauseP95Ms() float64 {
	stats := debug.GCStats{PauseQuantiles: make([]time.Duration, 101)}
	debug.ReadGCStats(&stats)
	if len(stats.PauseQuantiles) < 101 {
		return 0
	}
	return toMillis(stats.PauseQuantiles[95])
}

func toMillis(d time.Duration) float64 {
	return float64(d) / float64(time.Millisecond)
}
