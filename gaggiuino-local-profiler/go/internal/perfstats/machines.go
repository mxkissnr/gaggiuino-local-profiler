package perfstats

import (
	"sort"
	"sync"
	"time"
)

const (
	// machineWindowMinutes is the length of the per-host rolling window, in
	// one-minute buckets. It matches the HTTP recorder's recentWindow.
	machineWindowMinutes = int(recentWindow / time.Minute)
	// maxTrackedHosts caps how many distinct machine hosts keep their own
	// buckets. One slot is reserved for otherHost, so at most maxTrackedHosts-1
	// real hosts are tracked; any further host folds into otherHost and memory
	// stays bounded.
	maxTrackedHosts = 64
	// otherHost collects every host beyond maxTrackedHosts, and any host whose
	// string is literally "other".
	otherHost = "other"
)

// MachineCounter counts outbound traffic to the configured machines, keyed by
// the host string the callers already have: an HTTP request's URL host or a
// live WebSocket session's base URL. It is safe for concurrent use.
//
// Snapshot never returns a host: each host's counts are resolved to a machine
// id through the caller-supplied resolver, and hosts that do not resolve fold
// into one aggregate "unknown" entry. Per-host state is bounded — a fixed ring
// of 15 one-minute buckets and at most maxTrackedHosts host keys.
type MachineCounter struct {
	start       time.Time
	firstSample time.Time

	mu    sync.Mutex
	hosts map[string]*hostTraffic
}

// hostTraffic is one host's rolling window plus the host's current brew flag.
// Requests are classified as idle or brewing at write time using the flag in
// effect when they arrive, so a later brew start does not reclassify earlier
// traffic. WebSocket messages are not split.
type hostTraffic struct {
	brewing bool
	buckets [machineWindowMinutes]minuteBucket
}

// minuteBucket is one minute of one host's traffic. minute is the Unix minute
// (Unix seconds / 60) the bucket currently holds; a bucket whose minute no
// longer matches the current minute is reset in place before it is reused.
type minuteBucket struct {
	minute     int64
	reqIdle    int64
	reqBrewing int64
	wsMessages int64
	errors     int64
}

// NewMachineCounter returns a counter whose rate window starts now.
func NewMachineCounter() *MachineCounter {
	return newMachineCounterAt(time.Now())
}

func newMachineCounterAt(start time.Time) *MachineCounter {
	return &MachineCounter{start: start, hosts: map[string]*hostTraffic{}}
}

// CountRequest records one outbound HTTP request to host. failed marks a round
// trip that errored or returned a 5xx status.
func (c *MachineCounter) CountRequest(host string, failed bool) {
	if c == nil {
		return
	}
	c.countRequestAt(host, failed, time.Now())
}

func (c *MachineCounter) countRequestAt(host string, failed bool, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.markFirstSample(now)
	h := c.hostLocked(host)
	b := bucketFor(h, now)
	if h.brewing {
		b.reqBrewing++
	} else {
		b.reqIdle++
	}
	if failed {
		b.errors++
	}
}

// CountWSMessage records one WebSocket message received from host.
func (c *MachineCounter) CountWSMessage(host string) {
	if c == nil {
		return
	}
	c.countWSMessageAt(host, time.Now())
}

func (c *MachineCounter) countWSMessageAt(host string, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.markFirstSample(now)
	bucketFor(c.hostLocked(host), now).wsMessages++
}

// markFirstSample remembers the earliest counted traffic so the rate divisor
// never spans time before the counter saw any data. It must be called with
// c.mu held.
func (c *MachineCounter) markFirstSample(now time.Time) {
	if c.firstSample.IsZero() || now.Before(c.firstSample) {
		c.firstSample = now
	}
}

// SetBrewing records whether host is currently taking a shot, so subsequent
// HTTP requests split into the brewing bucket instead of the idle one.
func (c *MachineCounter) SetBrewing(host string, brewing bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hostLocked(host).brewing = brewing
}

// hostLocked returns host's traffic, creating it when new. It must be called
// with c.mu held. A new host past the cap is folded into otherHost so the map
// can never exceed maxTrackedHosts keys.
func (c *MachineCounter) hostLocked(host string) *hostTraffic {
	if h, ok := c.hosts[host]; ok {
		return h
	}
	if host != otherHost && len(c.hosts) >= maxTrackedHosts-1 {
		host = otherHost
		if h, ok := c.hosts[host]; ok {
			return h
		}
	}
	h := &hostTraffic{}
	c.hosts[host] = h
	return h
}

// bucketFor returns h's bucket for now's minute, resetting it in place when it
// still holds an older minute.
func bucketFor(h *hostTraffic, now time.Time) *minuteBucket {
	minute := now.Unix() / 60
	b := &h.buckets[minute%int64(machineWindowMinutes)]
	if b.minute != minute {
		*b = minuteBucket{minute: minute}
	}
	return b
}

// MachineTrafficSnapshot is one machine's outbound traffic over the window, or
// the aggregate of hosts that did not resolve to a machine. It never carries a
// host, IP or URL.
type MachineTrafficSnapshot struct {
	MachineID             int64   `json:"machine_id" jsonschema:"the registry id of the machine this traffic belongs to; 0 for the aggregate unknown entry"`
	Unknown               bool    `json:"unknown" jsonschema:"true for the single aggregate entry of hosts that did not resolve to a machine"`
	RequestsPerMinIdle    float64 `json:"requests_per_min_idle" jsonschema:"outbound HTTP requests per minute while no shot was active, over the last 15 minutes"`
	RequestsPerMinBrewing float64 `json:"requests_per_min_brewing" jsonschema:"outbound HTTP requests per minute while a shot was active, over the last 15 minutes"`
	WSMessagesPerMin      float64 `json:"ws_messages_per_min" jsonschema:"WebSocket messages per minute received from the machine, over the last 15 minutes"`
	ErrorsLast15Min       int64   `json:"errors_last_15min" jsonschema:"failed or 5xx machine requests in the last 15 minutes"`
}

// hostSums is one host's window totals, read under the lock before resolving.
type hostSums struct {
	idle    int64
	brewing int64
	ws      int64
	errors  int64
}

// Snapshot resolves each tracked host to a machine id and returns one entry per
// machine that saw traffic in the window, sorted by machine id with the
// aggregate unknown entry last. Hosts that do not resolve are combined into
// that single unknown entry. resolve may be nil, in which case every host
// counts as unknown.
func (c *MachineCounter) Snapshot(now time.Time, resolve func(host string) (machineID int64, ok bool)) []MachineTrafficSnapshot {
	if c == nil {
		return []MachineTrafficSnapshot{}
	}
	c.mu.Lock()
	sums := make(map[string]hostSums, len(c.hosts))
	for host, h := range c.hosts {
		var s hostSums
		for i := range h.buckets {
			b := h.buckets[i]
			if now.Unix()/60-b.minute >= int64(machineWindowMinutes) {
				continue
			}
			s.idle += b.reqIdle
			s.brewing += b.reqBrewing
			s.ws += b.wsMessages
			s.errors += b.errors
		}
		if s != (hostSums{}) {
			sums[host] = s
		}
	}
	c.mu.Unlock()

	minutes := c.rateMinutes(now)
	byMachine := map[int64]*MachineTrafficSnapshot{}
	var unknown *MachineTrafficSnapshot
	for host, s := range sums {
		var dest *MachineTrafficSnapshot
		id, ok := int64(0), false
		if resolve != nil {
			id, ok = resolve(host)
		}
		if ok {
			dest = byMachine[id]
			if dest == nil {
				dest = &MachineTrafficSnapshot{MachineID: id}
				byMachine[id] = dest
			}
		} else {
			if unknown == nil {
				unknown = &MachineTrafficSnapshot{Unknown: true}
			}
			dest = unknown
		}
		dest.RequestsPerMinIdle += float64(s.idle) / minutes
		dest.RequestsPerMinBrewing += float64(s.brewing) / minutes
		dest.WSMessagesPerMin += float64(s.ws) / minutes
		dest.ErrorsLast15Min += s.errors
	}

	out := make([]MachineTrafficSnapshot, 0, len(byMachine)+1)
	for _, m := range byMachine {
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MachineID < out[j].MachineID })
	if unknown != nil {
		out = append(out, *unknown)
	}
	return out
}

// rateMinutes is the divisor that turns a window count into a per-minute rate:
// the length of the window the buckets actually span, at least 1 so a young
// counter never divides by zero or reports a spike.
//
// The buckets hold the current minute plus the previous machineWindowMinutes-1
// full minutes, so the span grows from 14 minutes at the top of a minute to 15
// as the current minute fills. Dividing by a flat 15 would read up to about 7%
// low. A counter that has existed for less than that, or whose first sample is
// newer, spans only the shorter time.
func (c *MachineCounter) rateMinutes(now time.Time) float64 {
	window := float64(machineWindowMinutes-1) + now.Sub(now.Truncate(time.Minute)).Minutes()
	from := c.firstSample
	if from.IsZero() {
		from = c.start
	}
	if age := now.Sub(from).Minutes(); age < window {
		window = age
	}
	if window < 1 {
		window = 1
	}
	return window
}
