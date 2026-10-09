// Package perfstats keeps bounded, in-memory request timings for the
// get_perf_stats developer MCP tool. A Recorder wraps the app's mux as the
// innermost middleware, so it reads the route pattern net/http's ServeMux
// filled in on the request it just served — never the raw path or query
// string. Memory stays bounded no matter how much traffic arrives: every ring
// holds a fixed number of samples and the number of tracked routes is capped.
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
	// median/p95 computation. median/p95 describe this trailing window, not
	// the full history; count and max cover everything since start.
	ringSize = 512
	// recentWindow is the trailing window the second set of rings reports.
	recentWindow = 15 * time.Minute
	// maxRoutes caps how many distinct route patterns are tracked; further
	// patterns are folded into otherRoute so memory cannot grow without bound.
	maxRoutes = 256
	// unmatchedRoute is the key for a request no mux pattern claimed.
	unmatchedRoute = "unmatched"
	// otherRoute collects patterns beyond maxRoutes.
	otherRoute = "other"
)

// Recorder observes request timings. It is safe for concurrent use.
type Recorder struct {
	start time.Time

	mu     sync.Mutex
	routes map[string]*routeStats
}

type routeStats struct {
	all    *ring
	recent *ring
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

// totalStat describes every sample ever seen: count and max are exact, while
// median and p95 come from the retained ring.
func (r *ring) totalStat() (count int64, max, median, p95 time.Duration) {
	ds := make([]time.Duration, 0, r.count)
	for i := 0; i < r.count; i++ {
		ds = append(ds, r.samples[i].d)
	}
	median, p95 = quantiles(ds)
	return r.total, r.max, median, p95
}

// windowStat describes only samples at or after cutoff; older samples are
// dropped here, at read time, so no per-sample timer is needed.
func (r *ring) windowStat(cutoff time.Time) (count int64, max, median, p95 time.Duration) {
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
	return int64(len(ds)), max, median, p95
}

// ProcessStats is the process-wide half of a Snapshot.
type ProcessStats struct {
	UptimeS        float64 `json:"uptime_s" jsonschema:"seconds since the process started"`
	HeapInuseBytes uint64  `json:"heap_inuse_bytes" jsonschema:"Go heap in use, bytes"`
	SysBytes       uint64  `json:"sys_bytes" jsonschema:"total bytes obtained from the OS"`
	Goroutines     int     `json:"goroutines" jsonschema:"current goroutine count"`
	GCPauseP95Ms   float64 `json:"gc_pause_p95_ms" jsonschema:"95th-percentile GC pause since start, milliseconds"`
}

// RouteSnapshot is one route pattern's timings. The unsuffixed fields are
// since start; the Recent fields cover the last 15 minutes.
type RouteSnapshot struct {
	Route          string  `json:"route" jsonschema:"the route pattern, e.g. 'GET /api/shots/{id}'"`
	Count          int64   `json:"count" jsonschema:"requests since start"`
	MedianMs       float64 `json:"median_ms" jsonschema:"median duration over the most recent retained samples, milliseconds"`
	P95Ms          float64 `json:"p95_ms" jsonschema:"95th-percentile duration over the most recent retained samples, milliseconds"`
	MaxMs          float64 `json:"max_ms" jsonschema:"slowest request since start, milliseconds"`
	RecentCount    int64   `json:"recent_count" jsonschema:"requests in the last 15 minutes"`
	RecentMedianMs float64 `json:"recent_median_ms" jsonschema:"median duration in the last 15 minutes, milliseconds"`
	RecentP95Ms    float64 `json:"recent_p95_ms" jsonschema:"95th-percentile duration in the last 15 minutes, milliseconds"`
	RecentMaxMs    float64 `json:"recent_max_ms" jsonschema:"slowest request in the last 15 minutes, milliseconds"`
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
// The recorded key is method-qualified. ServeMux's r.Pattern already carries
// the method when the route was registered with one ("GET /api/shots/{id}"),
// but not when it was registered as a bare path ("/api/mcp"), so the method is
// prepended only when the pattern does not already start with it.
func (rec *Recorder) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		end := time.Now()
		route := unmatchedRoute
		if r.Pattern != "" {
			route = r.Pattern
			if !strings.HasPrefix(route, r.Method+" ") {
				route = r.Method + " " + route
			}
		}
		rec.record(route, end, end.Sub(start))
	})
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
		rs = &routeStats{all: newRing(), recent: newRing()}
		rec.routes[route] = rs
	}
	rs.all.add(at, d)
	rs.recent.add(at, d)
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
		count, max, median, p95 := rs.all.totalStat()
		recentCount, recentMax, recentMedian, recentP95 := rs.recent.windowStat(cutoff)
		routes = append(routes, RouteSnapshot{
			Route:          name,
			Count:          count,
			MedianMs:       toMillis(median),
			P95Ms:          toMillis(p95),
			MaxMs:          toMillis(max),
			RecentCount:    recentCount,
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
