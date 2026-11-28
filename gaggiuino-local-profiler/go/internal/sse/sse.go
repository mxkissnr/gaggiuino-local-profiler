package sse

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PingInterval is how often a bare keepalive comment line is written to an
// idle connection.
const PingInterval = 20 * time.Second

// paddingBytes is the #740 workaround: a 2048-space leading comment line
// (any line starting with ':' is a no-op per the SSE spec) written
// immediately after headers, to force a flush past whichever intermediate
// layer between the browser and this process is buffering the response (see
// doc.go).
const paddingBytes = 2048

// Event types this package's Handler multiplexes over /api/events:
// LIVE_SNAPSHOT/PREHEAT_UPDATE (#736). See doc.go for the events this
// endpoint deliberately does NOT carry.
const (
	EventLiveSnapshot  = "live-snapshot"
	EventPreheatUpdate = "preheat-update"
)

// Event is one push through a Hub. Data is marshaled to JSON — it should be
// a plain map or struct, not a pre-encoded string.
type Event struct {
	Type string
	Data any
	// MachineID scopes a machine's live-snapshot/preheat-update push
	// (#2247): 0 goes to every subscriber (the default machine's pushes and
	// every other event type, exactly as before), a machine id only to the
	// subscribers watching that machine (see Handler's ?machineId).
	MachineID int64
}

// subscriber is one open connection's delivery state: events is the channel
// Subscribe hands back, and resync (capacity 1) is a coalesced "a data-changed
// event was dropped for this connection" flag. A dropped snapshot is harmless
// (the next one carries the full state), but a dropped data-changed would leave
// that tab showing stale data until some unrelated refetch, so Publish remembers
// it here and the connection's handler closes the stream as soon as it sees it,
// forcing the client to reconnect and resync every kind.
type subscriber struct {
	events chan Event
	resync chan struct{}
	// watch is the machine id this connection watches (#2247), 0 for none.
	watch int64
}

// Hub is a minimal in-process pub/sub every open SSE connection subscribes
// to, and any domain package publishes onto via Publish. There is no
// listener-count cap to mirror — Go channels don't warn on subscriber count.
type Hub struct {
	mu   sync.Mutex
	subs map[<-chan Event]*subscriber
	// onWatch runs whenever a connection that watches a machine opens or
	// closes (#2247), set via SetWatchListener.
	onWatch func()
}

// NewHub returns an empty Hub, ready to use.
func NewHub() *Hub {
	return &Hub{subs: make(map[<-chan Event]*subscriber)}
}

// Publish fans ev out to every current subscriber. Delivery to each
// subscriber is non-blocking: a slow/stuck client's channel buffer (see
// Subscribe) filling up drops that one event for that subscriber only,
// rather than blocking every other subscriber or the publisher. An unbounded
// blocking send here would let one wedged HTTP connection stall event
// delivery to every other open tab.
//
// A dropped snapshot is fine — the next one replaces it (see
// coalesceLiveSnapshots) — but a dropped data-changed is not: that tab would
// never learn it should refetch. For that event type alone, a drop arms the
// subscriber's cap-1 resync channel so the connection's handler can close the
// stream and let the client reconnect and resync (see ServeHTTP).
func (h *Hub) Publish(ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.subs {
		if ev.MachineID != 0 && s.watch != ev.MachineID {
			continue
		}
		select {
		case s.events <- ev:
		default:
			if ev.Type == EventDataChanged {
				select {
				case s.resync <- struct{}{}:
				default:
				}
			}
		}
	}
}

// subscriberBuffer bounds how many undelivered events a single subscriber
// channel holds before Publish starts dropping for it — generous for this
// app's actual event rates (at most a few pushes per second).
const subscriberBuffer = 16

// Subscribe registers a new listener and returns its event channel plus an
// unsubscribe function the caller must call exactly once. Calling
// unsubscribe closes the channel; callers must stop reading from it once
// they've called unsubscribe.
func (h *Hub) Subscribe() (<-chan Event, func()) {
	s := &subscriber{
		events: make(chan Event, subscriberBuffer),
		resync: make(chan struct{}, 1),
	}
	h.mu.Lock()
	h.subs[s.events] = s
	h.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			h.mu.Lock()
			watch, fn := s.watch, h.onWatch
			delete(h.subs, s.events)
			h.mu.Unlock()
			close(s.events)
			if watch != 0 && fn != nil {
				go fn()
			}
		})
	}
	return s.events, unsubscribe
}

// resyncChan returns sub's coalesced-resync channel while sub is still
// subscribed, or nil once it has unsubscribed (its handler has then already
// returned, so the nil is never selected on).
func (h *Hub) resyncChan(sub <-chan Event) <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.subs[sub]; ok {
		return s.resync
	}
	return nil
}

// setWatch records the machine sub's connection watches (#2247) and tells
// the watch listener about it.
func (h *Hub) setWatch(sub <-chan Event, machineID int64) {
	h.mu.Lock()
	s, ok := h.subs[sub]
	if ok {
		s.watch = machineID
	}
	fn := h.onWatch
	h.mu.Unlock()
	if ok && machineID != 0 && fn != nil {
		go fn()
	}
}

// SetWatchListener installs fn, called in its own goroutine whenever a
// connection that watches a machine opens or closes (#2247). nil removes it.
func (h *Hub) SetWatchListener(fn func()) {
	h.mu.Lock()
	h.onWatch = fn
	h.mu.Unlock()
}

// WatchedMachines returns the machine ids at least one open connection
// watches (#2247).
func (h *Hub) WatchedMachines() map[int64]bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[int64]bool{}
	for _, s := range h.subs {
		if s.watch != 0 {
			out[s.watch] = true
		}
	}
	return out
}

// watchedMachine reads the machine a connection watches from its ?machineId
// (#2247). Absent, malformed or not positive means none: the connection then
// gets the default machine's pushes only, exactly as before.
func watchedMachine(r *http.Request) int64 {
	id, err := strconv.ParseInt(r.URL.Query().Get("machineId"), 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}

// Handler serves GET /api/events: same headers, same padding comment, same
// connect-time priming, same 20s keepalive, same event multiplexing. It does
// not perform auth itself — see doc.go — callers must wrap it with
// internal/auth.RequireToken the same way cmd/server does.
type Handler struct {
	// Hub is the pub/sub broker this handler subscribes new connections to.
	// Required.
	Hub *Hub

	// Prime, if set, is called once per new connection (after the padding
	// line and after subscribing to Hub) to obtain the connect-time snapshot
	// events a fresh connection should see (the syncProgress-map loop,
	// buildPreheatResponse(), buildLiveDataResponse()). The domain packages
	// own that state; this field lets them supply it without this package
	// importing them. nil means no priming, which is only correct until a
	// real Prime func is wired in.
	Prime func() []Event

	// PingInterval overrides PingInterval for tests that don't want to wait
	// 20 real seconds. Zero means use PingInterval.
	PingInterval time.Duration
}

// drainBuffered returns first plus every event already sitting in ch's
// buffer (a non-blocking drain — it never waits for a new event). closed is
// true when ch was closed mid-drain, so the caller can flush what it has
// and then exit.
func drainBuffered(ch <-chan Event, first Event) (batch []Event, closed bool) {
	batch = append(batch, first)
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return batch, true
			}
			batch = append(batch, e)
		default:
			return batch, false
		}
	}
}

// coalesceLiveSnapshots drops every live-snapshot event except the last one
// per machine (#2247: keyed by Event.MachineID, so a watched machine's
// snapshot never replaces the default machine's) — each one is a full state
// snapshot, so the intermediate ones are pure redundancy once a burst has
// queued up. Order of every other event type is preserved, and each surviving
// snapshot keeps the position of its machine's last one. Returns events
// unchanged when no machine has more than one snapshot in the batch.
func coalesceLiveSnapshots(events []Event) []Event {
	last := map[int64]int{}
	snapCount := 0
	for i, e := range events {
		if e.Type == EventLiveSnapshot {
			last[e.MachineID] = i
			snapCount++
		}
	}
	if snapCount <= len(last) {
		return events
	}
	out := make([]Event, 0, len(events)-snapCount+len(last))
	for i, e := range events {
		if e.Type == EventLiveSnapshot && last[e.MachineID] != i {
			continue
		}
		out = append(out, e)
	}
	return out
}

// ServeHTTP implements http.Handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if _, err := fmt.Fprintf(w, ":%s\n\n", strings.Repeat(" ", paddingBytes)); err != nil {
		return
	}
	flusher.Flush()

	send := func(ev Event) bool {
		payload, err := json.Marshal(ev.Data)
		if err != nil {
			// A future producer's Data must always be JSON-marshalable;
			// skip a malformed one rather than tearing down an otherwise
			// healthy connection over it.
			return true
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Subscribe before priming so an event published while the snapshots are
	// being assembled is queued for this connection instead of being lost in
	// the gap. The snapshot is still delivered first below; clients treat every
	// event as "newer state", so a queued event older than the snapshot is
	// harmless.
	sub, unsubscribe := h.Hub.Subscribe()
	defer unsubscribe()
	h.Hub.setWatch(sub, watchedMachine(r))
	resync := h.Hub.resyncChan(sub)

	if h.Prime != nil {
		for _, ev := range h.Prime() {
			if !send(ev) {
				return
			}
		}
	}

	pingInterval := h.PingInterval
	if pingInterval <= 0 {
		pingInterval = PingInterval
	}
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-sub:
			if !ok {
				return
			}
			// If a slow flush (Cloudflare-tunnel / ingress backpressure)
			// let this subscriber's channel back up, everything queued is
			// already stale. Every live-snapshot frame carries the FULL
			// live-data state (a growing datapoints array — see
			// system.buildLiveDataResponse), so replaying the intermediate
			// ones one-by-one just makes the chart trail the clock by up to
			// subscriberBuffer ticks (#901, the ~14s lag the maintainer saw). Drain
			// whatever else is buffered right now and drop all but the
			// newest live-snapshot; every other event type stays in order.
			batch, closed := drainBuffered(sub, ev)
			for _, e := range coalesceLiveSnapshots(batch) {
				if !send(e) {
					return
				}
			}
			if closed {
				return
			}
		case <-resync:
			// A data-changed was dropped for this connection while it was
			// backed up (see Publish). Rather than fabricate a whole-database
			// change -- which the client applies as a page reload, discarding
			// unsaved input -- close the stream: EventSource reconnects on its
			// own and the client's reconnect path resyncs every kind. This is
			// the backed-up, slow connection anyway, so dropping it is cheap.
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ":ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
