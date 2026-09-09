package sse

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// PingInterval ports routes/sse.js's PING_INTERVAL_MS: how often a bare
// keepalive comment line is written to an idle connection.
const PingInterval = 20 * time.Second

// paddingBytes ports routes/sse.js's #740 workaround: a 2048-space
// leading comment line (any line starting with ':' is a no-op per the SSE
// spec) written immediately after headers, to force a flush past whichever
// intermediate layer between the browser and this process is buffering the
// response (see doc.go).
const paddingBytes = 2048

// Event types this package's Handler multiplexes over /api/events — the
// exact set routes/sse.js forwards: SYNC_PROGRESS/SYNC_COMPLETE (#735),
// LIVE_SNAPSHOT/PREHEAT_UPDATE (#736); EventOrdersUpdate is new in this Go
// rewrite (#901, no Node equivalent — see below). See doc.go for the events
// this endpoint deliberately does NOT carry.
const (
	EventSyncProgress  = "sync-progress"
	EventSyncComplete  = "sync-complete"
	EventLiveSnapshot  = "live-snapshot"
	EventPreheatUpdate = "preheat-update"

	// EventOrdersUpdate carries a pre-rendered HTML fragment (Data must be
	// an HTML value, see below), not JSON — internal/web's Orders page
	// hx-swaps it straight into the barista queue via the vendored htmx
	// SSE extension's sse-swap, replacing that page's original 10s
	// hx-trigger="every 10s" poll. See HTML's own doc comment for why this
	// needed a new Data shape, not just a new event name.
	EventOrdersUpdate = "orders-update"
)

// HTML marks an Event's Data as a pre-rendered HTML fragment to be sent
// through the SSE stream unmarshaled (raw bytes, not JSON.stringify'd) —
// the fix for the second of the two concrete blockers go/README.md's
// Status section documents against using SSE for live updates:
// `internal/sse.Handler`'s `send()` used to unconditionally
// `json.Marshal()` every event's Data, but the htmx SSE extension's
// `sse-swap` attribute (unlike `hx-trigger="sse:*"`, dead code in the
// vendored 2.0.10 build — see that same section) expects an event's raw
// data to already BE the HTML it swaps in, not a JSON string of it. A
// producer that wants that behavior sets Data to an HTML value (a plain
// string conversion, `sse.HTML(rendered)`); Handler's send() type-switches
// on it and skips json.Marshal entirely for that one event — every other
// event type (live-snapshot, preheat-update, sync-progress/complete) is
// unaffected, since none of them are HTML and Node's own live.js JSON
// consumers depend on that encoding staying JSON (see this file's own
// EventOrdersUpdate doc comment for the one current producer).
type HTML string

// Event is one push through a Hub. Data is marshaled to JSON the same way
// routes/sse.js's send(type, data) calls JSON.stringify(data) — Data should
// be whatever value a future producer would otherwise have passed straight
// to JSON.stringify (a plain map or struct, not a pre-encoded string) —
// UNLESS Data is an HTML value (see that type's own doc comment), in which
// case it's sent through unmarshaled instead.
type Event struct {
	Type string
	Data any
}

// Hub is the Go port of lib/events.js's `bus` EventEmitter: a minimal
// in-process pub/sub every open SSE connection subscribes to, and any later
// domain package (Phase 1c+) publishes onto via Publish. Node's
// bus.setMaxListeners(50) has no Go equivalent needed — Go channels don't
// warn on listener/subscriber count.
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
// rather than blocking every other subscriber or the publisher — Node's
// EventEmitter.emit is synchronous and unbuffered so this failure mode has
// no direct equivalent there, but an unbounded blocking send here would let
// one wedged HTTP connection stall event delivery to every other open tab.
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
// app's actual event rates (at most a few pushes per second, see
// lib/middleware/rateLimit.js's traffic-budget comment for the same
// ballpark reasoning applied to HTTP requests).
const subscriberBuffer = 16

// Subscribe registers a new listener and returns its event channel plus an
// unsubscribe function the caller must call exactly once — the Go
// equivalent of routes/sse.js's req.on('close', ...) bus.off() cleanup.
// Calling unsubscribe closes the channel; callers must stop reading from it
// once they've called unsubscribe.
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

// Handler serves GET /api/events, the Go port of routes/sse.js: same
// headers, same padding comment, same connect-time priming, same 20s
// keepalive, same event multiplexing. It does not perform auth itself — see
// doc.go — callers must wrap it with internal/auth.RequireToken the same
// way cmd/server does.
type Handler struct {
	// Hub is the pub/sub broker this handler subscribes new connections to.
	// Required.
	Hub *Hub

	// Prime, if set, is called once per new connection (after the padding
	// line, before subscribing to Hub — matching routes/sse.js's ordering)
	// to obtain the connect-time snapshot events Node sends before
	// registering its bus listeners (the syncProgress-map loop,
	// buildPreheatResponse(), buildLiveDataResponse()). Phase 1c's domain
	// packages own that state; this field lets them supply it without this
	// package importing them. nil means no priming, which is only correct
	// until a real Prime func is wired in.
	Prime func() []Event

	// PingInterval overrides PingInterval for tests that don't want to wait
	// 20 real seconds. Zero means use PingInterval.
	PingInterval time.Duration
}

// sendHTML writes one SSE event whose data is raw HTML, not JSON — an SSE
// "data:" field can't itself contain a bare newline (the blank line ends
// the event), so a multi-line payload needs one "data: " line per line of
// html, exactly as the SSE spec requires and as sse-swap's own htmx
// extension expects to receive (it joins consecutive data: lines back
// together with "\n" before swapping). See HTML's own doc comment for why
// this bypasses json.Marshal entirely.
func sendHTML(w http.ResponseWriter, flusher http.Flusher, eventType, html string) bool {
	var b strings.Builder
	fmt.Fprintf(&b, "event: %s\n", eventType)
	for _, line := range strings.Split(html, "\n") {
		b.WriteString("data: ")
		b.WriteString(line)
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	if _, err := io.WriteString(w, b.String()); err != nil {
		return false
	}
	flusher.Flush()
	return true
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
		if html, ok := ev.Data.(HTML); ok {
			return sendHTML(w, flusher, ev.Type, string(html))
		}
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

	// Priming runs before Subscribe, same ordering as routes/sse.js (its
	// priming loop/sends run before the bus.on() registrations).
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
