package machines

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"nhooyr.io/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// gaggimate_live.go ports ws-client.js's GaggiMateLiveClient: a persistent,
// auto-reconnecting WebSocket session per GaggiMate baseURL that caches the
// unsolicited evt:status frames the controller pushes on its own cadence
// (#952). Before this, GaggiMateAdapter.GetStatus opened a fresh short-lived
// WebSocket on every call — and the live-poll loop calls GetStatus once a
// second, so a GaggiMate default machine meant a new WS connection every
// tick (PR #947's "GaggiMate HTTP/WS hammer"). This is the same
// session/reconnect/idle-eviction pattern as gaggiuinoLiveClient (live.go);
// only the cached payload differs — one evt:status map, not the two typed
// proto DTOs.

type gaggiMateLiveSession struct {
	mu       sync.Mutex
	status   map[string]any
	statusAt time.Time

	cancel    context.CancelFunc
	idleTimer *time.Timer
	// done is closed by run() when it returns — tests observe termination
	// without polling.
	done chan struct{}
}

// gaggiMateLiveClient mirrors gaggiuinoLiveClient's sessions-map shape.
type gaggiMateLiveClient struct {
	idleTimeout time.Duration

	mu       sync.Mutex
	sessions map[string]*gaggiMateLiveSession
}

func newGaggiMateLiveClient() *gaggiMateLiveClient {
	return &gaggiMateLiveClient{idleTimeout: liveIdleTimeout, sessions: make(map[string]*gaggiMateLiveSession)}
}

func (c *gaggiMateLiveClient) session(baseURL string) *gaggiMateLiveSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := c.sessions[baseURL]; ok {
		s.touch(c.idleTimeout)
		return s
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &gaggiMateLiveSession{cancel: cancel, done: make(chan struct{})}
	c.sessions[baseURL] = s
	s.idleTimer = time.AfterFunc(c.idleTimeout, func() { c.evictIdle(baseURL, s) })
	httputil.SafeGo("machines: gaggimate live session", func() { c.run(ctx, baseURL, s) })
	return s
}

func (s *gaggiMateLiveSession) touch(timeout time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Reset(timeout)
	}
}

func (c *gaggiMateLiveClient) evictIdle(baseURL string, s *gaggiMateLiveSession) {
	c.mu.Lock()
	if cur, ok := c.sessions[baseURL]; ok && cur == s {
		delete(c.sessions, baseURL)
	}
	c.mu.Unlock()
	s.cancel()
}

func (c *gaggiMateLiveClient) run(ctx context.Context, baseURL string, s *gaggiMateLiveSession) {
	defer close(s.done)
	for {
		if ctx.Err() != nil {
			return
		}
		c.connectOnce(ctx, baseURL, s)
		select {
		case <-ctx.Done():
			return
		case <-time.After(liveReconnectDelay):
		}
	}
}

// connectOnce re-validates baseURL's host on every reconnect attempt via
// assertLiveHost (live.go) before dialing — see that function's doc comment
// for why: only the adapter call that lazily opened this session ever went
// through BaseURLFor; run()'s reconnect loop dials again on its own every
// liveReconnectDelay, independent of any adapter call (#986 code review).
func (c *gaggiMateLiveClient) connectOnce(ctx context.Context, baseURL string, s *gaggiMateLiveSession) {
	if err := assertLiveHost(ctx, baseURL); err != nil {
		return
	}
	wsURL, err := gaggimateWSURL(baseURL)
	if err != nil {
		return
	}
	// HTTPClient: httpClient pins the dial to the guard-resolved IP (#987) —
	// see ws.go's wsConnect for the identical rationale.
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: httpClient})
	if err != nil {
		return
	}
	defer conn.CloseNow()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg["tp"] != "evt:status" {
			continue
		}
		s.mu.Lock()
		s.status = msg
		s.statusAt = time.Now()
		s.mu.Unlock()
	}
}

// Status returns the last cached evt:status for baseURL and whether it is
// fresh (within liveStaleAfter). Lazily (re)opens the session, exactly like
// gaggiuinoLiveClient.GetLiveSensorSnapshot.
func (c *gaggiMateLiveClient) Status(baseURL string) (map[string]any, bool) {
	s := c.session(baseURL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == nil || freshOrNilAt(s.statusAt) {
		return nil, false
	}
	return s.status, true
}

// Disconnect closes and forgets one machine's session.
func (c *gaggiMateLiveClient) Disconnect(baseURL string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.sessions[baseURL]
	if !ok {
		return
	}
	delete(c.sessions, baseURL)
	s.mu.Lock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.mu.Unlock()
	s.cancel()
}

// DisconnectForHost is the registry host-change/eviction hook, matching
// gaggiuinoLiveClient.DisconnectForHost.
func (c *gaggiMateLiveClient) DisconnectForHost(host string) {
	if baseURL, ok := normalizeBaseURL(host); ok {
		c.Disconnect(baseURL)
	}
}

// DisconnectAll closes every session — cmd/server's shutdown path and
// tests use it so no reconnect goroutine outlives the process/test.
func (c *gaggiMateLiveClient) DisconnectAll() {
	c.mu.Lock()
	sessions := c.sessions
	c.sessions = make(map[string]*gaggiMateLiveSession)
	c.mu.Unlock()
	for _, s := range sessions {
		s.mu.Lock()
		if s.idleTimer != nil {
			s.idleTimer.Stop()
		}
		s.mu.Unlock()
		s.cancel()
	}
}
