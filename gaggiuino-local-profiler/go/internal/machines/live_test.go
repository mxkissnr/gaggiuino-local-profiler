package machines

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// TestGaggiuinoLiveClient_IdleSessionTerminates is the #901 code-review
// regression test for the unbounded-reconnect goroutine leak: session()
// used to open a persistent WS session + reconnect goroutine with no upper
// bound, so a dead/unreachable host retried forever once anything had
// called GetLiveSensorSnapshot/GetLiveSystemState for it even once. Uses a
// short idleTimeout injected directly (same-package white-box access, not
// the production 5-minute value) and waits on the session's done channel
// instead of sleep-polling.
func TestGaggiuinoLiveClient_IdleSessionTerminates(t *testing.T) {
	c := newGaggiuinoLiveClient(sse.NewHub())
	c.idleTimeout = 30 * time.Millisecond

	// Port 1 is a well-known "connection refused" target — connectOnce's
	// Dial fails immediately, so run() spends its time in the
	// liveReconnectDelay wait, exactly where ctx cancellation (fired by the
	// idle timer) must interrupt it promptly.
	const baseURL = "http://127.0.0.1:1"

	c.GetLiveSensorSnapshot(baseURL) // opens the session as a side effect

	c.mu.Lock()
	s, ok := c.sessions[baseURL]
	c.mu.Unlock()
	if !ok {
		t.Fatal("expected session() to have created a session")
	}

	select {
	case <-s.done:
		// run() exited — the idle timer fired and cancelled its context.
	case <-time.After(2 * time.Second):
		t.Fatal("session did not terminate within 2s of its idle timeout — reconnect goroutine leaked")
	}

	c.mu.Lock()
	_, stillPresent := c.sessions[baseURL]
	c.mu.Unlock()
	if stillPresent {
		t.Fatal("expired session was not removed from the sessions map")
	}

	// A later call must lazily reopen a brand-new session, same as the
	// very first call did — the bound must not "poison" the host forever.
	c.GetLiveSensorSnapshot(baseURL)
	c.mu.Lock()
	s2, ok := c.sessions[baseURL]
	c.mu.Unlock()
	if !ok {
		t.Fatal("expected a later call to lazily reopen a session")
	}
	if s2 == s {
		t.Fatal("expected a fresh session object after idle eviction, got the same (already-cancelled) one")
	}
}

// countingWSServer accepts every WebSocket dial at /ws, counts how many it
// has accepted, and holds each connection open (until the request's context
// is done) so a test can force a drop on demand — enough to prove whether
// connectOnce actually dialed on a given reconnect attempt, with no need
// for real Gaggiuino protobuf frames.
type countingWSServer struct {
	*httptest.Server
	conns  atomic.Int64
	mu     sync.Mutex
	active []*websocket.Conn
}

func newCountingWSServer() *countingWSServer {
	f := &countingWSServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", f.handleWS)
	f.Server = httptest.NewServer(mux)
	return f
}

func (f *countingWSServer) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	f.conns.Add(1)
	f.mu.Lock()
	f.active = append(f.active, conn)
	f.mu.Unlock()
	defer conn.CloseNow()
	<-r.Context().Done()
}

func (f *countingWSServer) dropConns() {
	f.mu.Lock()
	conns := f.active
	f.active = nil
	f.mu.Unlock()
	for _, c := range conns {
		c.CloseNow()
	}
}

// TestGaggiuinoLiveClient_ReconnectRevalidatesHost is the #986 regression
// test: connectOnce used to dial baseURL on every automatic reconnect
// without re-running the SSRF guard — only the session's original open
// (reached through the adapter's BaseURLFor a moment earlier) was ever
// validated. Allow the loopback fake server through allowLoopbackMachineHost
// (httptest.Server only ever binds to 127.0.0.1, which the real guard
// correctly blocks for any actual machine host), let the reconnect loop
// dial once, then flip machineHostGuard to reject as if the host had
// started failing validation — the next reconnect attempt must NOT dial.
func TestGaggiuinoLiveClient_ReconnectRevalidatesHost(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newCountingWSServer()
	defer fake.Close()

	c := newGaggiuinoLiveClient(sse.NewHub())
	c.idleTimeout = time.Hour
	t.Cleanup(func() { c.Disconnect(fake.URL) })
	base := fake.URL

	c.GetLiveSensorSnapshot(base) // opens the session, first dial happens
	waitUntil(t, time.Second, func() bool { return fake.conns.Load() >= 1 })

	orig := machineHostGuard.set(func(ctx context.Context, hostname string) error {
		return errors.New("host no longer valid")
	})
	t.Cleanup(func() { machineHostGuard.set(orig) })

	fake.dropConns()
	// liveReconnectDelay (3s) plus margin — long enough for run() to have
	// attempted (and, pre-fix, succeeded at) at least one more reconnect.
	time.Sleep(liveReconnectDelay + 2*time.Second)
	if got := fake.conns.Load(); got != 1 {
		t.Fatalf("connectOnce dialed after the host started failing validation: conns=%d, want 1", got)
	}
}
