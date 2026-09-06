package machines

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// streamingGaggiMate is a fake GaggiMate controller that keeps pushing
// evt:status frames on each connection (unlike newFakeGaggiMateMachine's
// one-shot), and counts how many WebSocket connections it has accepted —
// the persistent client (gaggimate_live.go) must open exactly one, not one
// per Status() call.
type streamingGaggiMate struct {
	*httptest.Server
	conns  atomic.Int64
	mu     sync.Mutex
	temp   float64
	pushMs time.Duration
	active []*websocket.Conn
}

func newStreamingGaggiMate() *streamingGaggiMate {
	f := &streamingGaggiMate{temp: 90, pushMs: 15 * time.Millisecond}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", f.handleWS)
	f.Server = httptest.NewServer(mux)
	return f
}

func (f *streamingGaggiMate) setTemp(v float64) { f.mu.Lock(); f.temp = v; f.mu.Unlock() }

func (f *streamingGaggiMate) dropConns() {
	f.mu.Lock()
	conns := f.active
	f.active = nil
	f.mu.Unlock()
	for _, c := range conns {
		c.CloseNow()
	}
}

func (f *streamingGaggiMate) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	f.conns.Add(1)
	f.mu.Lock()
	f.active = append(f.active, conn)
	f.mu.Unlock()
	defer conn.CloseNow()
	ctx := r.Context()
	t := time.NewTicker(f.pushMs)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f.mu.Lock()
			temp := f.temp
			f.mu.Unlock()
			frame, _ := json.Marshal(map[string]any{"tp": "evt:status", "ct": temp, "tt": 93.0, "pr": 0.0, "m": 0, "p": "Espresso"})
			if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
				return
			}
		}
	}
}

func TestGaggiMateLiveClient_CachesAndReusesOneConnection(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newStreamingGaggiMate()
	defer fake.Close()

	c := newGaggiMateLiveClient()
	c.idleTimeout = time.Hour
	t.Cleanup(c.DisconnectAll)

	base := fake.URL

	// First call opens the session; the first frame may not have arrived yet.
	c.Status(base)
	waitUntil(t, time.Second, func() bool {
		st, ok := c.Status(base)
		return ok && st["ct"] == 90.0
	})

	// Many more reads over ~150ms — still exactly one connection.
	for i := 0; i < 20; i++ {
		c.Status(base)
		time.Sleep(5 * time.Millisecond)
	}
	if n := fake.conns.Load(); n != 1 {
		t.Fatalf("opened %d WebSocket connections, want 1 (persistent session)", n)
	}

	// A new value propagates through the same session.
	fake.setTemp(94.5)
	waitUntil(t, time.Second, func() bool {
		st, ok := c.Status(base)
		return ok && st["ct"] == 94.5
	})
}

func TestGaggiMateLiveClient_ReconnectsAfterDrop(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newStreamingGaggiMate()
	c := newGaggiMateLiveClient()
	c.idleTimeout = time.Hour
	t.Cleanup(c.DisconnectAll)
	base := fake.URL

	waitUntil(t, time.Second, func() bool { _, ok := c.Status(base); return ok })
	if n := fake.conns.Load(); n != 1 {
		t.Fatalf("expected 1 connection after warm-up, got %d", n)
	}

	// Drop every connection; the reconnect loop (liveReconnectDelay) brings
	// the session back. The cached frame stays served (staleness window is
	// 15s) so reconnect is observed via the connection count, and fresh
	// frames must resume flowing after it.
	fake.setTemp(77)
	fake.dropConns()
	waitUntil(t, 6*time.Second, func() bool { return fake.conns.Load() >= 2 })
	waitUntil(t, time.Second, func() bool {
		st, ok := c.Status(base)
		return ok && st["ct"] == 77.0
	})
}

// TestGaggiMateLiveClient_ReconnectRevalidatesHost is the #986 regression
// test's GaggiMate counterpart — see live_test.go's
// TestGaggiuinoLiveClient_ReconnectRevalidatesHost for the full rationale.
func TestGaggiMateLiveClient_ReconnectRevalidatesHost(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newStreamingGaggiMate()
	defer fake.Close()

	c := newGaggiMateLiveClient()
	c.idleTimeout = time.Hour
	t.Cleanup(c.DisconnectAll)
	base := fake.URL

	waitUntil(t, time.Second, func() bool { _, ok := c.Status(base); return ok })
	if n := fake.conns.Load(); n != 1 {
		t.Fatalf("expected 1 connection after warm-up, got %d", n)
	}

	orig := machineHostGuard.set(func(ctx context.Context, hostname string) error {
		return errors.New("host no longer valid")
	})
	t.Cleanup(func() { machineHostGuard.set(orig) })

	fake.dropConns()
	time.Sleep(liveReconnectDelay + 2*time.Second)
	if n := fake.conns.Load(); n != 1 {
		t.Fatalf("connectOnce dialed after the host started failing validation: conns=%d, want 1", n)
	}
}

func TestGaggiMateAdapter_GetStatusUsesPersistentCache(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newStreamingGaggiMate()
	defer fake.Close()

	lc := newGaggiMateLiveClient()
	lc.idleTimeout = time.Hour
	t.Cleanup(lc.DisconnectAll)
	a := NewGaggiMateAdapter(lc)
	m := testGaggiMateMachine(fake.URL)

	// Warm the cache.
	waitUntil(t, time.Second, func() bool { _, ok := lc.Status(fake.URL); return ok })
	connsAfterWarm := fake.conns.Load()

	for i := 0; i < 10; i++ {
		st, err := a.GetStatus(context.Background(), m)
		if err != nil {
			t.Fatalf("GetStatus: %v", err)
		}
		if !st.Reachable || st.Temperature != 90.0 {
			t.Fatalf("unexpected status: %+v", st)
		}
	}
	if fake.conns.Load() != connsAfterWarm {
		t.Fatalf("GetStatus opened new connections (%d -> %d) instead of reading the cache",
			connsAfterWarm, fake.conns.Load())
	}
}

func waitUntil(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}
