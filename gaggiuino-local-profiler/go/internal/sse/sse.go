package sse

import (
	"encoding/json"
	"fmt"
	"net/http"
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
}

// Hub is a minimal in-process pub/sub every open SSE connection subscribes
// to, and any domain package publishes onto via Publish. There is no
// listener-count cap to mirror — Go channels don't warn on subscriber count.
type Hub struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

// NewHub returns an empty Hub, ready to use.
func NewHub() *Hub {
	return &Hub{subs: make(map[chan Event]struct{})}
}

// Publish fans ev out to every current subscriber. Delivery to each
// subscriber is non-blocking: a slow/stuck client's channel buffer (see
// Subscribe) filling up drops that one event for that subscriber only,
// rather than blocking every other subscriber or the publisher. An unbounded
// blocking send here would let one wedged HTTP connection stall event
// delivery to every other open tab.
func (h *Hub) Publish(ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
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
	ch := make(chan Event, subscriberBuffer)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, ch)
			h.mu.Unlock()
			close(ch)
		})
	}
	return ch, unsubscribe
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
	// line, before subscribing to Hub) to obtain the connect-time snapshot
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

// coalesceLiveSnapshots drops every live-snapshot event except the last —
// each one is a full state snapshot, so the intermediate ones are pure
// redundancy once a burst has queued up. Order of every other event type is
// preserved, and the surviving snapshot keeps the position of the last one.
// Returns events unchanged (no allocation) when it holds 0 or 1 snapshots.
func coalesceLiveSnapshots(events []Event) []Event {
	lastSnap, snapCount := -1, 0
	for i, e := range events {
		if e.Type == EventLiveSnapshot {
			lastSnap = i
			snapCount++
		}
	}
	if snapCount <= 1 {
		return events
	}
	out := make([]Event, 0, len(events)-snapCount+1)
	for i, e := range events {
		if e.Type == EventLiveSnapshot && i != lastSnap {
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

	// Priming runs before Subscribe, so a fresh connection's snapshots are
	// sent before any event published after it subscribes.
	if h.Prime != nil {
		for _, ev := range h.Prime() {
			if !send(ev) {
				return
			}
		}
	}

	sub, unsubscribe := h.Hub.Subscribe()
	defer unsubscribe()

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
			// subscriberBuffer ticks (#901, the ~14s lag Max saw). Drain
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
		case <-ping.C:
			if _, err := fmt.Fprint(w, ":ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
