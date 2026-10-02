package machines

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// This file holds the persistent, auto-reconnecting WebSocket session per
// machine baseURL that caches the continuously-pushed d_sensor_snap/
// d_sys_state frames (#597), read by GET /api/machine/live (via
// gaggiuinoAdapter.GetLiveSensorSnapshot/GetLiveSystemState) without
// opening a fresh connection per poll — staying within the firmware's
// WS_MAX_CONNECTIONS=3 budget regardless of poll frequency.
//
// An earlier version of this file also Publish()ed every cache update
// directly onto the shared internal/sse.Hub as an EventLiveSnapshot event —
// an explicitly-flagged stand-in ("the payload shape here ... is NOT
// necessarily the same shape openapi.yaml's LiveData schema documents ...
// reconciling the two is system-domain work"). That reconciliation is done
// (#901, go/internal/system): only the system poller's own
// emitLiveSnapshot() publishes LIVE_SNAPSHOT; the WS client (this file)
// only updates a cache the poller reads from, never publishes itself. This
// file now matches that: `hub` is kept (constructor signature unchanged,
// still threaded through from cmd/server) only because a later phase may
// want a narrower, WS-session-specific SSE event of its own; nothing in
// this file calls Hub.Publish today. See go/internal/system/doc.go for the
// full story.
//
// The GaggiMate equivalent (the GaggiMateLiveClient class) is its own file
// now — gaggimate_live.go (#952) — added once the system-domain live-poll
// loop landed and started calling GaggiMateAdapter.GetStatus once a second
// for a GaggiMate default machine (PR #947's "GaggiMate WS hammer"). Same
// session/reconnect/idle-eviction pattern as this file; it caches one
// evt:status map instead of the two typed proto DTOs.

const (
	liveReconnectDelay = 3 * time.Second
	liveStaleAfter     = 15 * time.Second

	// liveIdleTimeout closes a machine's persistent live WebSocket session
	// (and stops its reconnect goroutine) after this long without a
	// GetLiveSensorSnapshot/GetLiveSystemState call for that host (#901
	// code review): session() opens this session as a side effect of a
	// simple cache read, with no upper bound before the fix — a dead/
	// unreachable host left an unbounded goroutine retrying every
	// liveReconnectDelay forever, even after nothing was polling
	// GET /api/machine/live anymore. 5 minutes comfortably outlives any
	// normal gap between UI polls (the dashboard polls every few seconds
	// while a machine's live view is open) while still bounding the leak
	// once a client actually stops asking; a later GetLiveSensorSnapshot/
	// GetLiveSystemState call lazily reopens the session exactly like the
	// very first call did, so nothing user-visible changes besides the
	// bound.
	liveIdleTimeout = 5 * time.Minute
)

type gaggiuinoLiveSession struct {
	mu           sync.Mutex
	sensorSnap   *proto.SensorStateSnapshotDto
	sensorSnapAt time.Time
	sysState     *proto.SystemStateDto
	sysStateAt   time.Time

	cancel    context.CancelFunc
	idleTimer *time.Timer
	// done is closed by run() when it returns (ctx cancelled, whether by
	// Disconnect/DisconnectForHost or by the idle timer) — tests use this
	// to observe termination without a time.Sleep poll loop.
	done chan struct{}
}

// gaggiuinoLiveClient holds the per-host sessions plus the connect/disconnect
// logic as a struct so cmd/server can own one instance instead of relying on
// package-level global state.
type gaggiuinoLiveClient struct {
	hub *sse.Hub

	// idleTimeout is liveIdleTimeout in production; tests override it
	// directly (same package, unexported field) to a short value instead
	// of waiting out the real 5 minutes.
	idleTimeout time.Duration

	mu       sync.Mutex
	sessions map[string]*gaggiuinoLiveSession
}

func newGaggiuinoLiveClient(hub *sse.Hub) *gaggiuinoLiveClient {
	return &gaggiuinoLiveClient{hub: hub, idleTimeout: liveIdleTimeout, sessions: make(map[string]*gaggiuinoLiveSession)}
}

// session lazily opens or reuses a session, and resets the idle timer on
// every reuse (#901 code review) so an actively-polled session never expires
// mid-use.
func (c *gaggiuinoLiveClient) session(baseURL string) *gaggiuinoLiveSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := c.sessions[baseURL]; ok {
		s.touch(c.idleTimeout)
		return s
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &gaggiuinoLiveSession{cancel: cancel, done: make(chan struct{})}
	c.sessions[baseURL] = s
	s.idleTimer = time.AfterFunc(c.idleTimeout, func() { c.evictIdle(baseURL, s) })
	httputil.SafeGo("machines: gaggiuino live session", func() { c.run(ctx, baseURL, s) })
	return s
}

// touch resets s's idle timer to timeout — called whenever a live read
// actually uses this session, so idleTimeout measures time since the last
// real caller, not time since the session was opened.
func (s *gaggiuinoLiveSession) touch(timeout time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Reset(timeout)
	}
}

// evictIdle fires when s's idle timer expires: removes s from the sessions
// map (only if it's still the current session for baseURL — a concurrent
// Disconnect/DisconnectForHost or a brand-new session may have already
// replaced it) and cancels its context, which stops run()'s reconnect loop.
func (c *gaggiuinoLiveClient) evictIdle(baseURL string, s *gaggiuinoLiveSession) {
	c.mu.Lock()
	if cur, ok := c.sessions[baseURL]; ok && cur == s {
		delete(c.sessions, baseURL)
	}
	c.mu.Unlock()
	s.cancel()
}

// run keeps dialing baseURL, with a fixed pause between attempts, until ctx
// is cancelled (by Disconnect or by the idle timer).
func (c *gaggiuinoLiveClient) run(ctx context.Context, baseURL string, s *gaggiuinoLiveSession) {
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

// assertLiveHost re-runs the SSRF guard on baseURL's hostname (#986 code
// review): BaseURLFor validates the host once, at the adapter call that
// lazily opened this session, but run()'s reconnect loop calls connectOnce
// again every liveReconnectDelay entirely on its own, with no adapter call
// (and no BaseURLFor) anywhere near it. Without this, a host that starts
// failing validation after the session opens — re-pointed via DNS, or a
// registry Host/Type change racing DisconnectForHost — would still get
// dialed by the background reconnect loop forever. Reuses machineHostGuard,
// the exact same seam BaseURLFor calls, so tests that already stub it (e.g.
// allowLoopbackMachineHost) cover this path too.
func assertLiveHost(ctx context.Context, baseURL string) error {
	u, err := url.Parse(baseURL)
	if err != nil {
		return err
	}
	return machineHostGuard.get()(ctx, u.Hostname())
}

// connectOnce dials once and reads frames until the connection closes or
// errors, updating s's cache for every d_sensor_snap/d_sys_state push. No
// longer publishes onto the SSE hub directly — see this file's header
// comment.
func (c *gaggiuinoLiveClient) connectOnce(ctx context.Context, baseURL string, s *gaggiuinoLiveSession) {
	if err := assertLiveHost(ctx, baseURL); err != nil {
		return
	}
	wsURL, err := gaggiuinoWSURL(baseURL)
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
			return // closed/errored/ctx cancelled — run() decides whether to reconnect
		}
		var envelope proto.WebSocketMessageDto
		if err := envelope.Unmarshal(data); err != nil {
			continue // not a valid envelope frame, ignore
		}
		// See ws.go's wsSendAndWait doc comment on the identical
		// `!envelope.data` check — always false (an empty bytes field
		// decodes to a truthy empty slice, never nil), so it never actually
		// filters; only the action switch below does.

		switch envelope.Action {
		case pushSensor:
			var snap proto.SensorStateSnapshotDto
			if err := snap.Unmarshal(envelope.Data); err != nil {
				continue
			}
			s.mu.Lock()
			s.sensorSnap = &snap
			s.sensorSnapAt = time.Now()
			s.mu.Unlock()
		case pushSysState:
			var state proto.SystemStateDto
			if err := state.Unmarshal(envelope.Data); err != nil {
				continue
			}
			s.mu.Lock()
			s.sysState = &state
			s.sysStateAt = time.Now()
			s.mu.Unlock()
		}
	}
}

// freshOrNilAt reports a cached value older than liveStaleAfter as
// unavailable rather than serving it stale.
func freshOrNilAt(at time.Time) bool { return time.Since(at) > liveStaleAfter }

// GetLiveSensorSnapshot lazily (re)opens the session as a side effect.
func (c *gaggiuinoLiveClient) GetLiveSensorSnapshot(baseURL string) *proto.SensorStateSnapshotDto {
	s := c.session(baseURL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sensorSnap == nil || freshOrNilAt(s.sensorSnapAt) {
		return nil
	}
	return s.sensorSnap
}

// GetLiveSystemState lazily (re)opens the session as a side effect.
func (c *gaggiuinoLiveClient) GetLiveSystemState(baseURL string) *proto.SystemStateDto {
	s := c.session(baseURL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sysState == nil || freshOrNilAt(s.sysStateAt) {
		return nil
	}
	return s.sysState
}

// Disconnect closes and forgets exactly one machine's session.
func (c *gaggiuinoLiveClient) Disconnect(baseURL string) {
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

// normalizeBaseURL applies the same session-key normalization the connect
// path uses (scheme defaulted to http://, then re-serialized), minus the
// async SSRF check — eviction of a now-unreachable machine's stale session
// must not depend on that host still resolving. Returns ("", false) for an
// empty/unparseable host.
func normalizeBaseURL(host string) (string, bool) {
	raw := strings.TrimSpace(host)
	if raw == "" {
		return "", false
	}
	withScheme := raw
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		withScheme = "http://" + raw
	}
	u, err := url.Parse(withScheme)
	if err != nil {
		return "", false
	}
	return u.Scheme + "://" + u.Host, true
}

// DisconnectForHost closes a host's session by raw host string —
// registry.go's UpdateMachine/DeleteMachine onHostChanged/onHostEvicted
// callbacks wire straight to this.
func (c *gaggiuinoLiveClient) DisconnectForHost(host string) {
	baseURL, ok := normalizeBaseURL(host)
	if ok {
		c.Disconnect(baseURL)
	}
}
