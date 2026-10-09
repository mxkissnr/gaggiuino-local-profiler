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

	"github.com/coder/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfstats"
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
	// partial switches the fake to firmware v1.9.0 framing: a slow state frame
	// (m, p, bc, cw — no live readings) first, then alternating slow/fast
	// frames. fast frames carry process unless processNull is set, in which
	// case they send it as JSON null to exercise the clearing rule.
	partial     bool
	processNull bool
	active      []*websocket.Conn
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
	i := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			frame := f.frameFor(i)
			i++
			if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
				return
			}
		}
	}
}

// frameFor builds the i-th evt:status frame pushed to a freshly accepted
// connection: 0 is the slow snapshot, odd indices are fast telemetry frames,
// even indices are slow snapshots again (partial mode).
func (f *streamingGaggiMate) frameFor(i int) []byte {
	f.mu.Lock()
	partial := f.partial
	processNull := f.processNull
	temp := f.temp
	f.mu.Unlock()

	var frame map[string]any
	if !partial {
		frame = map[string]any{"tp": "evt:status", "ct": temp, "tt": 93.0, "pr": 0.0, "m": 0, "p": "Espresso"}
	} else if i%2 == 0 {
		frame = map[string]any{"tp": "evt:status", "m": 2, "p": "Espresso", "bc": true, "cw": 18.5}
	} else {
		var process any = map[string]any{"a": 1, "s": "brew"}
		if processNull {
			process = nil
		}
		frame = map[string]any{"tp": "evt:status", "ct": temp, "tt": 93.0, "pr": 1.2, "fl": 2.0, "process": process}
	}
	b, _ := json.Marshal(frame)
	return b
}

func (f *streamingGaggiMate) setPartial(v bool) {
	f.mu.Lock()
	f.partial = v
	f.mu.Unlock()
}

func (f *streamingGaggiMate) setProcessNull(v bool) {
	f.mu.Lock()
	f.processNull = v
	f.mu.Unlock()
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

func TestMergeGaggiMateStatus(t *testing.T) {
	prev := map[string]any{"tp": "evt:status", "p": "Espresso", "m": 2.0, "bc": true}
	fast := map[string]any{"tp": "evt:status", "ct": 91.5, "pr": 1.2, "process": map[string]any{"a": 1.0, "s": "brew"}}

	merged := mergeGaggiMateStatus(prev, fast)
	if merged["p"] != "Espresso" || merged["m"] != 2.0 || merged["bc"] != true {
		t.Fatalf("slow keys lost in merge: %+v", merged)
	}
	if merged["ct"] != 91.5 || merged["pr"] != 1.2 {
		t.Fatalf("fast keys missing in merge: %+v", merged)
	}
	if _, ok := merged["process"]; !ok {
		t.Fatalf("process missing from merge: %+v", merged)
	}
	// The merge copies: the previous map must be untouched.
	if _, ok := prev["ct"]; ok {
		t.Fatalf("merge mutated the previous map: %+v", prev)
	}

	// A null clears a previously cached key; an absent key keeps its value.
	cleared := mergeGaggiMateStatus(merged, map[string]any{"tp": "evt:status", "process": nil})
	if _, ok := cleared["process"]; ok {
		t.Fatalf("null did not clear process: %+v", cleared)
	}
	if cleared["ct"] != 91.5 || cleared["p"] != "Espresso" {
		t.Fatalf("absent keys were not kept: %+v", cleared)
	}
	if _, ok := merged["process"]; !ok {
		t.Fatalf("clearing mutated the previous map: %+v", merged)
	}
}

// TestGaggiMateLiveClient_MergesPartialFrames covers firmware v1.9.0's split
// frames: the cached status must carry the slow state keys and the latest fast
// live readings, and must be a fresh map (callers keep the one Status returned).
func TestGaggiMateLiveClient_MergesPartialFrames(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newStreamingGaggiMate()
	fake.setPartial(true)
	defer fake.Close()

	c := newGaggiMateLiveClient()
	c.idleTimeout = time.Hour
	t.Cleanup(c.DisconnectAll)
	base := fake.URL

	var merged map[string]any
	waitUntil(t, 2*time.Second, func() bool {
		st, ok := c.Status(base)
		merged = st
		return ok && st["ct"] == 90.0 && st["p"] == "Espresso"
	})
	if merged["m"] != 2.0 || merged["bc"] != true {
		t.Fatalf("slow keys missing after merge: %+v", merged)
	}
	if merged["pr"] != 1.2 {
		t.Fatalf("fast key missing after merge: %+v", merged)
	}

	// Later frames must not mutate the map Status() already handed out.
	fake.setTemp(95.5)
	waitUntil(t, 2*time.Second, func() bool {
		st, ok := c.Status(base)
		return ok && st["ct"] == 95.5
	})
	if merged["ct"] != 90.0 {
		t.Fatalf("Status() map mutated by later frames: ct=%v", merged["ct"])
	}

	// A fast frame that sends process as null clears the cached process.
	fake.setProcessNull(true)
	waitUntil(t, 2*time.Second, func() bool {
		st, ok := c.Status(base)
		if !ok {
			return false
		}
		_, has := st["process"]
		return !has && st["p"] == "Espresso"
	})
}

// TestGaggiMateWaitForStatus_MergesPartialFrames checks that the short-lived
// fallback does not return the slow snapshot alone: it must merge until a fast
// frame supplies the live readings, keeping the slow keys alongside them.
func TestGaggiMateWaitForStatus_MergesPartialFrames(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newStreamingGaggiMate()
	fake.setPartial(true)
	defer fake.Close()

	got, err := gaggimateWaitForStatus(context.Background(), fake.URL, 3*time.Second)
	if err != nil {
		t.Fatalf("gaggimateWaitForStatus: %v", err)
	}
	if got["ct"] != 90.0 || got["pr"] != 1.2 {
		t.Fatalf("merged status missing live readings: %+v", got)
	}
	if got["p"] != "Espresso" || got["m"] != 2.0 || got["bc"] != true {
		t.Fatalf("merged status missing slow keys: %+v", got)
	}
}

// TestGaggiMateLiveClient_ShotSavedEventFiresHook covers #1409: firmware
// v1.9.0+ announces a new history shot with evt:history-shot-saved, which must
// fire the installed hook exactly once — while the evt:status frame that
// follows must not fire it again.
func TestGaggiMateLiveClient_ShotSavedEventFiresHook(t *testing.T) {
	allowLoopbackMachineHost(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"tp":"evt:history-shot-saved","id":42}`))
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"tp":"evt:status","ct":91.0}`))
		<-ctx.Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newGaggiMateLiveClient()
	c.idleTimeout = time.Hour
	t.Cleanup(c.DisconnectAll)

	var fired atomic.Int32
	c.setOnShotSaved(func() { fired.Add(1) })

	c.Status(srv.URL)
	waitUntil(t, time.Second, func() bool {
		st, ok := c.Status(srv.URL)
		return fired.Load() == 1 && ok && st["ct"] == 91.0
	})

	// The status frame that arrives after the event must not fire the hook.
	time.Sleep(30 * time.Millisecond)
	if n := fired.Load(); n != 1 {
		t.Fatalf("shot-saved hook fired %d times, want exactly 1 (a status frame must not fire it)", n)
	}
}

// TestGaggiMateLiveClient_ClearsBrewingFlagOnSessionEnd is the #1568 review
// fix for the stuck brewing flag: while a live session reports a running brew
// the host's requests are filed as brewing, but once the session ends (ctx
// cancel or read error) the flag must be cleared so later traffic is idle.
func TestGaggiMateLiveClient_ClearsBrewingFlagOnSessionEnd(t *testing.T) {
	allowLoopbackMachineHost(t)
	counter := perfstats.NewMachineCounter()
	SetMachineTrafficCounter(counter)
	t.Cleanup(func() { SetMachineTrafficCounter(nil) })

	fake := newStreamingGaggiMate()
	fake.setPartial(true) // fast frames carry process.a==1 / stage brew
	defer fake.Close()

	c := newGaggiMateLiveClient()
	c.idleTimeout = time.Hour
	t.Cleanup(c.DisconnectAll)
	base := fake.URL
	host := hostFromBaseURL(base)

	brewing := func(at time.Time) float64 {
		for _, snap := range counter.Snapshot(at, nil) {
			if snap.Unknown {
				return snap.RequestsPerMinBrewing
			}
		}
		return 0
	}

	// Retry a counted request until one lands in the brewing bucket — proof the
	// live session has pushed a brewing status and set the flag.
	waitUntil(t, 2*time.Second, func() bool {
		countMachineRequest(host, false)
		return brewing(time.Now()) > 0
	})

	// Compare at one fixed instant so the rate divisor is identical on both
	// sides — then equality is a count comparison.
	at := time.Now()
	before := brewing(at)

	c.DisconnectAndWait(base)

	// After the session ended the flag must be clear: this request is idle and
	// the brewing rate does not move. Without the fix it accrues as brewing.
	countMachineRequest(host, false)
	if after := brewing(at); after != before {
		t.Fatalf("brewing traffic kept accruing after the live session ended: before=%v after=%v", before, after)
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
