package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
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
//
// Profile requests (req:profiles:*) are also sent through this persistent
// connection via Request(), avoiding the "GaggiMate only allows one
// concurrent WS client" problem that blocked the previous approach of
// disconnecting the live client and opening a second short-lived connection.

type gaggimateInflightReq struct {
	resType string
	rid     string
	result  chan map[string]any
}

type gaggiMateLiveSession struct {
	mu       sync.Mutex
	status   map[string]any
	statusAt time.Time

	cancel    context.CancelFunc
	idleTimer *time.Timer
	// done is closed by run() when it returns.
	done chan struct{}

	// inflight holds pending req:*/res:* correlations sent through the live conn.
	inflightMu sync.Mutex
	inflight   []*gaggimateInflightReq

	// outgoing carries frames to send; connectOnce drains it in its select loop.
	outgoing chan []byte
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
	s := &gaggiMateLiveSession{
		cancel:   cancel,
		done:     make(chan struct{}),
		outgoing: make(chan []byte, 4),
	}
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

	// Reader goroutine feeds frames into readCh so the select loop below can
	// interleave reads with outgoing frame writes.
	readCh := make(chan []byte, 1)
	readErrCh := make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				// Non-blocking: select loop may have already exited.
				select {
				case readErrCh <- err:
				default:
				}
				return
			}
			select {
			case readCh <- data:
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		select {
		case data := <-readCh:
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			tp, _ := msg["tp"].(string)
			if tp == "evt:status" {
				s.mu.Lock()
				s.status = msg
				s.statusAt = time.Now()
				s.mu.Unlock()
			} else if strings.HasPrefix(tp, "res:") {
				s.dispatchResponse(msg)
			}

		case frame := <-s.outgoing:
			if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
				return
			}

		case <-readErrCh:
			return

		case <-ctx.Done():
			return
		}
	}
}

func (s *gaggiMateLiveSession) addInflight(req *gaggimateInflightReq) {
	s.inflightMu.Lock()
	s.inflight = append(s.inflight, req)
	s.inflightMu.Unlock()
}

func (s *gaggiMateLiveSession) removeInflight(req *gaggimateInflightReq) {
	s.inflightMu.Lock()
	for i, r := range s.inflight {
		if r == req {
			s.inflight = append(s.inflight[:i], s.inflight[i+1:]...)
			break
		}
	}
	s.inflightMu.Unlock()
}

func (s *gaggiMateLiveSession) dispatchResponse(msg map[string]any) {
	tp, _ := msg["tp"].(string)
	msgRID := fmt.Sprint(msg["rid"])
	s.inflightMu.Lock()
	defer s.inflightMu.Unlock()
	// TODO: rid-less frames match the first inflight of that resType (FIFO).
	// DeleteProfile sends req:profiles:delete then req:profiles:list; a
	// concurrent ListProfiles can race a rid-less list response to the wrong
	// waiter. Fix: correlate by send-order within the same resType and add a
	// test for two concurrent req:profiles:list calls.
	for _, req := range s.inflight {
		if req.resType == tp && (msg["rid"] == nil || req.rid == msgRID) {
			select {
			case req.result <- msg:
			default:
			}
			return
		}
	}
}

// Request sends a req:* frame through the persistent live WS connection and
// waits for the matching res:* response. Reuses the existing connection so
// there is no second dial — GaggiMate's single-client constraint is never hit.
func (c *gaggiMateLiveClient) Request(ctx context.Context, baseURL, reqType string, payload map[string]any) (map[string]any, error) {
	if len(reqType) < 4 || reqType[:4] != "req:" {
		return nil, fmt.Errorf("not a request type: %s", reqType)
	}
	resType := "res:" + reqType[4:]
	rid := rand.Intn(1_000_000_000)

	frame := map[string]any{"tp": reqType, "rid": rid}
	for k, v := range payload {
		frame[k] = v
	}
	body, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}

	s := c.session(baseURL)
	result := make(chan map[string]any, 1)
	req := &gaggimateInflightReq{resType: resType, rid: fmt.Sprint(rid), result: result}
	s.addInflight(req)
	defer s.removeInflight(req)

	select {
	case s.outgoing <- body:
	case <-s.done:
		return nil, fmt.Errorf("live session closed before sending %s request", reqType)
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	select {
	case res := <-result:
		return res, nil
	case <-s.done:
		return nil, fmt.Errorf("live session closed while waiting for %s", resType)
	case <-ctx.Done():
		return nil, ctx.Err()
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

// Disconnect closes and forgets one machine's session. Non-blocking: the
// session's run() goroutine exits asynchronously. Use DisconnectAndWait
// when the caller needs the WS connection to be fully closed before
// opening a new one.
func (c *gaggiMateLiveClient) Disconnect(baseURL string) {
	c.mu.Lock()
	s, ok := c.sessions[baseURL]
	if !ok {
		c.mu.Unlock()
		return
	}
	delete(c.sessions, baseURL)
	s.mu.Lock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.mu.Unlock()
	s.cancel()
	c.mu.Unlock()
}

// DisconnectAndWait is like Disconnect but blocks until the session's
// run() goroutine has exited.
func (c *gaggiMateLiveClient) DisconnectAndWait(baseURL string) {
	c.mu.Lock()
	s, ok := c.sessions[baseURL]
	if !ok {
		c.mu.Unlock()
		return
	}
	delete(c.sessions, baseURL)
	s.mu.Lock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.mu.Unlock()
	s.cancel()
	c.mu.Unlock()
	<-s.done
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
