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
	start time.Time

	mu    sync.Mutex
	hosts map[string]*hostTraffic
}

// hostTraffic is one host's rolling window. firstSample is the first time the
// host was counted, so its rate is divided by its own age rather than the
// counter's. Each bucket records the requests seen in its minute and whether a
// shot was running at any point in that minute; a request is classified by its
// minute's flag, so all traffic in a brewing minute counts as brewing.
type hostTraffic struct {
	firstSample time.Time
	buckets     [machineWindowMinutes]minuteBucket
}

// minuteBucket is one minute of one host's traffic. minute is the Unix minute
// (Unix seconds / 60) the bucket currently holds; a bucket whose minute no
// longer matches the current minute is reset in place before it is reused.
type minuteBucket struct {
	minute     int64
	requests   int64
	brewing    bool
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
	b := bucketFor(c.hostLocked(host, now), now)
	b.requests++
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
	bucketFor(c.hostLocked(host, now), now).wsMessages++
}

// SetBrewing marks host's current minute as brewing, so Snapshot reports that
// minute's requests under requests_per_min_brewing. It never creates a host
// entry: an untracked host is ignored. A false value is a no-op, because a
// minute counts as brewing when a shot was active at any point in it.
func (c *MachineCounter) SetBrewing(host string, brewing bool) {
	if c == nil {
		return
	}
	c.setBrewingAt(host, brewing, time.Now())
}

func (c *MachineCounter) setBrewingAt(host string, brewing bool, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	h, ok := c.hosts[host]
	if !ok || !brewing {
		return
	}
	bucketFor(h, now).brewing = true
}

// hostLocked returns host's traffic, creating it when new with firstSample set
// to now, the host's own age origin. It must be called with c.mu held. A new
// host past the cap is folded into otherHost so the map can never exceed
// maxTrackedHosts keys.
func (c *MachineCounter) hostLocked(host string, now time.Time) *hostTraffic {
	if h, ok := c.hosts[host]; ok {
		return h
	}
	if host != otherHost && len(c.hosts) >= maxTrackedHosts-1 {
		host = otherHost
		if h, ok := c.hosts[host]; ok {
			return h
		}
	}
	h := &hostTraffic{firstSample: now}
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

// hostSpan is one host's window totals, read under the lock and turned into
// rates after unlocking. The minutes of the host's own age are split by whether
// the minute was brewing.
type hostSpan struct {
	idleRequests    int64
	idleMinutes     float64
	brewingRequests int64
	brewingMinutes  float64
	ws              int64
	errors          int64
	spanMinutes     float64
}

// rate divides count by minutes, reporting 0 when the host had no minutes of
// that kind — so a machine that never brewed never reports a brewing rate.
func (s hostSpan) rate(count int64, minutes float64) float64 {
	if minutes <= 0 {
		return 0
	}
	return float64(count) / minutes
}

// Snapshot resolves each tracked host to a machine id and returns one entry per
// machine that saw traffic in the window, sorted by machine id with the
// aggregate unknown entry last. Hosts that do not resolve are combined into
// that single unknown entry. resolve may be nil, in which case every host
// counts as unknown. The per-host sums are read under the lock and turned into
// rates after unlocking.
func (c *MachineCounter) Snapshot(now time.Time, resolve func(host string) (machineID int64, ok bool)) []MachineTrafficSnapshot {
	if c == nil {
		return []MachineTrafficSnapshot{}
	}
	c.mu.Lock()
	spans := make(map[string]hostSpan, len(c.hosts))
	for host, h := range c.hosts {
		spans[host] = hostSpanLocked(h, c.start, now)
	}
	c.mu.Unlock()

	byMachine := map[int64]*MachineTrafficSnapshot{}
	var unknown *MachineTrafficSnapshot
	for host, s := range spans {
		if s.idleRequests == 0 && s.brewingRequests == 0 && s.ws == 0 && s.errors == 0 {
			continue
		}
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
		dest.RequestsPerMinIdle += s.rate(s.idleRequests, s.idleMinutes)
		dest.RequestsPerMinBrewing += s.rate(s.brewingRequests, s.brewingMinutes)
		dest.WSMessagesPerMin += s.rate(s.ws, s.spanMinutes)
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

// hostSpanLocked sums h's buckets that fall inside the rolling window, splitting
// the time they span into brewing and idle minutes from the host's own first
// sample. It must be called with c.mu held. fallback is the counter's start,
// used only for a host with no recorded first sample.
func hostSpanLocked(h *hostTraffic, fallback, now time.Time) hostSpan {
	var s hostSpan
	from := h.firstSample
	if from.IsZero() {
		from = fallback
	}
	if from.After(now) {
		from = now
	}

	lastMinute := now.Unix() / 60
	firstMinute := from.Unix() / 60
	if oldest := lastMinute - int64(machineWindowMinutes-1); firstMinute < oldest {
		firstMinute = oldest
	}

	for m := firstMinute; m <= lastMinute; m++ {
		lo := time.Unix(m*60, 0)
		if lo.Before(from) {
			lo = from
		}
		hi := time.Unix((m+1)*60, 0)
		if hi.After(now) {
			hi = now
		}
		if !hi.After(lo) {
			continue
		}
		minutes := hi.Sub(lo).Minutes()

		b := &h.buckets[m%int64(machineWindowMinutes)]
		brewing := b.minute == m && b.brewing
		if brewing {
			s.brewingMinutes += minutes
		} else {
			s.idleMinutes += minutes
		}
		if b.minute == m {
			if brewing {
				s.brewingRequests += b.requests
			} else {
				s.idleRequests += b.requests
			}
			s.ws += b.wsMessages
			s.errors += b.errors
		}
		s.spanMinutes += minutes
	}
	return s
}
