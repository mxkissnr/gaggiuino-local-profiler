package sse

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHub_PublishFanOutAndUnsubscribe(t *testing.T) {
	h := NewHub()
	sub1, cancel1 := h.Subscribe()
	sub2, cancel2 := h.Subscribe()
	defer cancel2()

	ev := Event{Type: EventSyncProgress, Data: map[string]any{"current": 1}}
	h.Publish(ev)

	for _, sub := range []<-chan Event{sub1, sub2} {
		select {
		case got := <-sub:
			if got.Type != EventSyncProgress {
				t.Errorf("got event type %q, want %q", got.Type, EventSyncProgress)
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for published event")
		}
	}

	cancel1()
	if _, ok := <-sub1; ok {
		t.Error("expected sub1's channel to be closed after cancel")
	}

	// A second publish must still reach the still-subscribed sub2 and must
	// not panic/block because sub1 unsubscribed.
	h.Publish(Event{Type: EventSyncComplete, Data: nil})
	select {
	case got := <-sub2:
		if got.Type != EventSyncComplete {
			t.Errorf("got event type %q, want %q", got.Type, EventSyncComplete)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second published event")
	}
}

func TestHub_PublishNonBlockingWhenSubscriberBufferFull(t *testing.T) {
	h := NewHub()
	_, cancel := h.Subscribe() // never read from
	defer cancel()

	done := make(chan struct{})
	go func() {
		for i := 0; i < subscriberBuffer+10; i++ {
			h.Publish(Event{Type: EventLiveSnapshot, Data: i})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber buffer instead of dropping")
	}
}

// readLines reads exactly n newline-terminated lines from r, failing the
// test if that doesn't happen within timeout — a real network connection's
// Read can block forever on a handler bug, so every read in this file goes
// through this helper rather than calling bufio.Reader directly.
func readLines(t *testing.T, r *bufio.Reader, n int, timeout time.Duration) []string {
	t.Helper()
	type result struct {
		lines []string
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		var lines []string
		for len(lines) < n {
			line, err := r.ReadString('\n')
			if err != nil {
				ch <- result{lines, err}
				return
			}
			lines = append(lines, line)
		}
		ch <- result{lines, nil}
	}()
	select {
	case out := <-ch:
		if out.err != nil {
			t.Fatalf("reading SSE stream: %v", out.err)
		}
		return out.lines
	case <-time.After(timeout):
		t.Fatal("timed out reading SSE stream")
		return nil
	}
}

// TestHandler_ConnectPrimeAndPublish opens a real HTTP connection to a
// Handler and verifies the headers, the padding comment, connect-time
// priming, and that an event published after connecting is delivered over
// the same stream — the four things Phase 1b's dispatch explicitly calls
// out as needing coverage.
func TestHandler_ConnectPrimeAndPublish(t *testing.T) {
	hub := NewHub()
	primed := Event{Type: EventPreheatUpdate, Data: map[string]any{"ready": true}}
	handler := &Handler{
		Hub:   hub,
		Prime: func() []Event { return []Event{primed} },
	}
	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/events")
	if err != nil {
		t.Fatalf("GET %s: %v", srv.URL, err)
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache, no-transform" {
		t.Errorf("Cache-Control = %q, want no-cache, no-transform", cc)
	}
	if xab := resp.Header.Get("X-Accel-Buffering"); xab != "no" {
		t.Errorf("X-Accel-Buffering = %q, want no", xab)
	}

	reader := bufio.NewReader(resp.Body)

	// Padding line, blank line, then the primed event's "event:"/"data:"
	// lines and its trailing blank line.
	lines := readLines(t, reader, 5, 2*time.Second)

	wantPadding := ":" + strings.Repeat(" ", paddingBytes) + "\n"
	if lines[0] != wantPadding {
		t.Errorf("padding line = %d bytes, want %d bytes starting with ':'", len(lines[0]), len(wantPadding))
	}
	if lines[1] != "\n" {
		t.Errorf("expected blank line after padding, got %q", lines[1])
	}
	if lines[2] != "event: "+EventPreheatUpdate+"\n" {
		t.Errorf("primed event line = %q, want \"event: %s\\n\"", lines[2], EventPreheatUpdate)
	}
	if !strings.HasPrefix(lines[3], "data: ") {
		t.Fatalf("expected a data: line, got %q", lines[3])
	}
	var primedData map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(lines[3], "data: ")), &primedData); err != nil {
		t.Fatalf("decoding primed event data: %v", err)
	}
	if primedData["ready"] != true {
		t.Errorf("primed event data = %v, want ready:true", primedData)
	}
	if lines[4] != "\n" {
		t.Errorf("expected trailing blank line after primed data, got %q", lines[4])
	}

	// Give the handler a moment to finish Subscribe()-ing before publishing
	// — priming and subscribing happen before this call returns control to
	// the client, but the network round trip above doesn't guarantee it.
	time.Sleep(50 * time.Millisecond)
	hub.Publish(Event{Type: EventSyncProgress, Data: map[string]any{"current": 3, "total": 10}})

	pubLines := readLines(t, reader, 3, 2*time.Second)
	if pubLines[0] != "event: "+EventSyncProgress+"\n" {
		t.Errorf("published event line = %q, want \"event: %s\\n\"", pubLines[0], EventSyncProgress)
	}
	var pubData map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(pubLines[1], "data: ")), &pubData); err != nil {
		t.Fatalf("decoding published event data: %v", err)
	}
	if pubData["current"] != float64(3) || pubData["total"] != float64(10) {
		t.Errorf("published event data = %v, want current:3 total:10", pubData)
	}
	if pubLines[2] != "\n" {
		t.Errorf("expected trailing blank line after published data, got %q", pubLines[2])
	}
}

// TestHandler_PublishHTMLEvent pins HTML's own contract (#901, orders.templ's
// live-update mechanism): an Event whose Data is an HTML value is sent
// through unmarshaled — one "data: " line per line of the HTML, not a
// json.Marshal'd JSON string — so a multi-line fragment survives the SSE
// wire format's "one data: line per line of payload" requirement, and the
// htmx SSE extension's sse-swap sees the raw markup it expects, not a
// quoted JSON string of it.
func TestHandler_PublishHTMLEvent(t *testing.T) {
	hub := NewHub()
	handler := &Handler{Hub: hub}
	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/events")
	if err != nil {
		t.Fatalf("GET %s: %v", srv.URL, err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)

	// Padding + blank line before this connection is ready to receive a
	// publish, same ordering TestHandler_ConnectPrimeAndPublish already
	// relies on.
	readLines(t, reader, 2, 2*time.Second)
	time.Sleep(50 * time.Millisecond)

	html := "<div>line one</div>\n<div>line two</div>"
	hub.Publish(Event{Type: EventOrdersUpdate, Data: HTML(html)})

	// event: line, one data: line per line of html (2), trailing blank line.
	lines := readLines(t, reader, 4, 2*time.Second)
	if lines[0] != "event: "+EventOrdersUpdate+"\n" {
		t.Errorf("event line = %q, want \"event: %s\\n\"", lines[0], EventOrdersUpdate)
	}
	if lines[1] != "data: <div>line one</div>\n" {
		t.Errorf("first data line = %q, want the raw HTML line unmarshaled", lines[1])
	}
	if lines[2] != "data: <div>line two</div>\n" {
		t.Errorf("second data line = %q, want the raw HTML line unmarshaled", lines[2])
	}
	if lines[3] != "\n" {
		t.Errorf("expected trailing blank line after the HTML data, got %q", lines[3])
	}
}

func TestHandler_Ping(t *testing.T) {
	hub := NewHub()
	handler := &Handler{Hub: hub, PingInterval: 30 * time.Millisecond}
	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/events")
	if err != nil {
		t.Fatalf("GET %s: %v", srv.URL, err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	// Padding + blank (no Prime set), then the first ping comment + blank.
	lines := readLines(t, reader, 4, 2*time.Second)
	if lines[2] != ":ping\n" {
		t.Errorf("expected a :ping keepalive line, got %q", lines[2])
	}
	if lines[3] != "\n" {
		t.Errorf("expected blank line after :ping, got %q", lines[3])
	}
}

func TestHandler_NoFlusherRejected(t *testing.T) {
	handler := &Handler{Hub: NewHub()}
	rec := httptest.NewRecorder()
	// httptest.NewRecorder's ResponseWriter does implement http.Flusher in
	// modern Go, so wrap it in a type that deliberately doesn't, to exercise
	// the "streaming unsupported" guard.
	handler.ServeHTTP(noFlushRecorder{rec}, httptest.NewRequest(http.MethodGet, "/api/events", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 for a non-flushable ResponseWriter, got %d", rec.Code)
	}
}

// noFlushRecorder wraps http.ResponseWriter while hiding any Flush method
// the embedded value has, so it never satisfies http.Flusher.
type noFlushRecorder struct {
	http.ResponseWriter
}

// ── live-snapshot coalescing (#901 — the ~14s chart lag) ─────────────────

func TestCoalesceLiveSnapshots(t *testing.T) {
	snap := func(n int) Event { return Event{Type: EventLiveSnapshot, Data: n} }
	preheat := Event{Type: EventPreheatUpdate, Data: "p"}
	orders := Event{Type: EventOrdersUpdate, Data: HTML("<div/>")}

	t.Run("keeps only the last snapshot, other events in order", func(t *testing.T) {
		in := []Event{snap(1), preheat, snap(2), snap(3), orders, snap(4)}
		got := coalesceLiveSnapshots(in)
		want := []Event{preheat, orders, snap(4)}
		if len(got) != len(want) {
			t.Fatalf("got %d events %v, want %d %v", len(got), got, len(want), want)
		}
		for i := range want {
			if got[i].Type != want[i].Type || got[i].Data != want[i].Data {
				t.Errorf("event %d = %+v, want %+v", i, got[i], want[i])
			}
		}
	})

	t.Run("no allocation / passthrough for 0 or 1 snapshots", func(t *testing.T) {
		one := []Event{preheat, snap(9), orders}
		if got := coalesceLiveSnapshots(one); &got[0] != &one[0] {
			t.Error("expected the input slice returned unchanged for a single snapshot")
		}
		none := []Event{preheat, orders}
		if got := coalesceLiveSnapshots(none); &got[0] != &none[0] {
			t.Error("expected the input slice returned unchanged for no snapshots")
		}
	})
}

// gatedFlusher is a ResponseWriter+Flusher whose Flush blocks until the test
// sends on release — lets the test wedge the handler's send() mid-stream and
// pile up events on the subscriber channel, reproducing ingress backpressure.
type gatedFlusher struct {
	mu      sync.Mutex
	buf     strings.Builder
	release chan struct{}
	hdr     http.Header
}

func newGatedFlusher() *gatedFlusher {
	return &gatedFlusher{release: make(chan struct{}), hdr: http.Header{}}
}
func (g *gatedFlusher) Header() http.Header { return g.hdr }
func (g *gatedFlusher) WriteHeader(int)     {}
func (g *gatedFlusher) Write(p []byte) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.buf.Write(p)
}
func (g *gatedFlusher) Flush()       { <-g.release }
func (g *gatedFlusher) body() string { g.mu.Lock(); defer g.mu.Unlock(); return g.buf.String() }
func (g *gatedFlusher) letFlush(n int) {
	for i := 0; i < n; i++ {
		g.release <- struct{}{}
	}
}

func TestHandler_SlowConsumerGetsOnlyLatestSnapshot(t *testing.T) {
	hub := NewHub()
	h := &Handler{Hub: hub, PingInterval: time.Hour}
	gw := newGatedFlusher()
	ctx, cancelReq := context.WithCancel(context.Background())
	defer cancelReq()
	req := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)

	done := make(chan struct{})
	go func() { h.ServeHTTP(gw, req); close(done) }()

	// Handler writes the padding line then blocks on its first Flush.
	gw.letFlush(1) // release padding flush -> handler proceeds to Subscribe()

	// Wait until it has subscribed.
	deadline := time.After(2 * time.Second)
	for {
		hub.mu.Lock()
		n := len(hub.subs)
		hub.mu.Unlock()
		if n == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("handler never subscribed")
		case <-time.After(5 * time.Millisecond):
		}
	}

	// First snapshot: handler wakes, sends it, blocks on Flush.
	hub.Publish(Event{Type: EventLiveSnapshot, Data: map[string]any{"seq": 1}})
	time.Sleep(20 * time.Millisecond)

	// While the handler is wedged on that Flush, a burst piles up on the
	// subscriber channel: 8 more snapshots with an orders event in the middle.
	for i := 2; i <= 5; i++ {
		hub.Publish(Event{Type: EventLiveSnapshot, Data: map[string]any{"seq": i}})
	}
	hub.Publish(Event{Type: EventOrdersUpdate, Data: HTML("<div>queue</div>")})
	for i := 6; i <= 9; i++ {
		hub.Publish(Event{Type: EventLiveSnapshot, Data: map[string]any{"seq": i}})
	}

	// Let the handler drain: release enough flushes for snap1 + the coalesced
	// batch (orders + snap9). Do it from a goroutine so we don't deadlock if
	// the handler needs fewer/more flushes than expected.
	flushDone := make(chan struct{})
	go func() {
		defer close(flushDone)
		for i := 0; i < 6; i++ {
			select {
			case gw.release <- struct{}{}:
			case <-done:
				return
			case <-time.After(time.Second):
				return
			}
		}
	}()
	time.Sleep(80 * time.Millisecond)

	body := gw.body()
	snaps := strings.Count(body, "event: "+EventLiveSnapshot+"\n")
	if snaps != 2 {
		t.Errorf("live-snapshot frames sent = %d, want 2 (the pre-burst one + one coalesced), body:\n%s", snaps, body)
	}
	if got := strings.Count(body, "event: "+EventOrdersUpdate+"\n"); got != 1 {
		t.Errorf("orders-update frames = %d, want 1", got)
	}
	if !strings.Contains(body, `"seq":9`) {
		t.Errorf("expected the newest snapshot (seq 9) in the stream, body:\n%s", body)
	}
	if strings.Contains(body, `"seq":5`) || strings.Contains(body, `"seq":2`) {
		t.Errorf("intermediate snapshots should have been coalesced away, body:\n%s", body)
	}

	// Tear down: cancel the request, then keep releasing flushes until the
	// handler goroutine returns.
	cancelReq()
	for {
		select {
		case gw.release <- struct{}{}:
		case <-done:
			<-flushDone
			return
		case <-time.After(2 * time.Second):
			t.Fatal("handler did not exit after request cancel")
		}
	}
}
