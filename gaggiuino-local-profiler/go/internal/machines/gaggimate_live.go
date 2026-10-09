package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// gaggimate_live.go holds the GaggiMateLiveClient: a persistent,
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

// gaggimateOutgoingFrame is a frame queued for the live WS writer. expires is
// zero for frames that must always be sent (profile requests); control frames
// carry a short TTL so a command queued while the connection was down cannot
// fire after a later reconnect (#1324). Dropping is done by the select loop in
// connectOnce via expired().
type gaggimateOutgoingFrame struct {
	data    []byte
	expires time.Time
}

// expired reports whether this frame's TTL has passed and it must be dropped
// instead of written. A zero expires never expires.
func (f gaggimateOutgoingFrame) expired(now time.Time) bool {
	return !f.expires.IsZero() && now.After(f.expires)
}

type gaggiMateLiveSession struct {
	mu       sync.Mutex
	status   map[string]any
	statusAt time.Time
	// connected is true while connectOnce holds a live WS connection; version
	// is the controller's last-reported displayVersion (empty until the
	// res:ota-settings reply arrives). Both guarded by mu (#1324).
	connected bool
	version   string

	// brew-confirmation state (#1324): a brew start blocked by error-level
	// warnings is announced with evt:brew:confirm, whose warn[].k keys are
	// stored in confirm (in order). confirmPending is true while such a
	// prompt is outstanding; confirmAt bounds it by brewConfirmTTL. All
	// guarded by mu.
	confirm        []string
	confirmAt      time.Time
	confirmPending bool

	cancel    context.CancelFunc
	idleTimer *time.Timer
	// done is closed by run() when it returns.
	done chan struct{}

	// inflight holds pending req:*/res:* correlations sent through the live conn.
	inflightMu sync.Mutex
	inflight   []*gaggimateInflightReq

	// outgoing carries frames to send; connectOnce drains it in its select loop.
	outgoing chan gaggimateOutgoingFrame
}

// gaggiMateLiveClient mirrors gaggiuinoLiveClient's sessions-map shape.
type gaggiMateLiveClient struct {
	idleTimeout time.Duration

	mu       sync.Mutex
	sessions map[string]*gaggiMateLiveSession

	// onShotSaved is fired when the controller reports evt:history-shot-saved
	// (firmware v1.9.0+, #1409), guarded by mu. It runs on the session's read
	// loop, so it must not block — see setOnShotSaved.
	onShotSaved func()
}

func newGaggiMateLiveClient() *gaggiMateLiveClient {
	return &gaggiMateLiveClient{idleTimeout: liveIdleTimeout, sessions: make(map[string]*gaggiMateLiveSession)}
}

// setOnShotSaved installs the hook fired when the controller reports
// evt:history-shot-saved. The hook runs on the session's read loop, so it must
// not block — it should hand any real work off to a goroutine (see
// machines.Handlers.SetOnShotSaved and system.Poller.SyncAfterShotSaved).
func (c *gaggiMateLiveClient) setOnShotSaved(fn func()) {
	c.mu.Lock()
	c.onShotSaved = fn
	c.mu.Unlock()
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
		outgoing: make(chan gaggimateOutgoingFrame, 4),
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

	host := hostFromBaseURL(baseURL)

	// A new connection starts a new session: drop the status merged from the
	// previous connection so stale live readings can't survive a reconnect. The
	// controller sends a full snapshot to every client right after it connects.
	// The firmware version is reset too — it is re-requested below and only a
	// fresh reply may re-enable control (#1324).
	s.mu.Lock()
	s.status = nil
	s.connected = true
	s.version = ""
	// A new connection also drops any outstanding brew confirmation: it
	// belonged to the previous connection's session.
	s.clearBrewConfirmLocked()
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.connected = false
		s.mu.Unlock()
	}()

	// Ask for the firmware version right away; firmware v1.9.0 answers with
	// res:ota-settings and caches displayVersion in s.version. Control is only
	// offered once a >=1.9.0 version has arrived (#1324).
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"tp":"req:ota-settings"}`)); err != nil {
		return
	}

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
			countMachineWSMessage(host)
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
				// Firmware v1.9.0 sends partial frames: merge onto the last
				// status (absent key keeps, null clears) instead of replacing.
				s.status = mergeGaggiMateStatus(s.status, msg)
				s.statusAt = time.Now()
				// A status that shows the brew running (process.a==1) or that
				// leaves brew mode (m present and != 1) resolves any pending
				// brew confirmation (#1324).
				if s.confirmPending {
					proc, _ := s.status["process"].(map[string]any)
					if looseFloat(proc["a"]) == 1 {
						s.clearBrewConfirmLocked()
					} else if m, ok := s.status["m"]; ok && looseFloat(m) != 1 {
						s.clearBrewConfirmLocked()
					}
				}
				// A status carrying the brew process (process.a==1, stage
				// brew/infusion) marks this host as taking a shot, so the
				// traffic counter splits its requests into the brewing bucket.
				brewing := gaggiMateBrewing(s.status)
				s.mu.Unlock()
				setMachineBrewing(host, brewing)
			} else if tp == "evt:brew:confirm" {
				// A brew start was blocked by error-level warnings; the
				// controller asks every UI to confirm or decline. Store the
				// warning keys in order (#1324).
				keys := []string{}
				if warn, ok := msg["warn"].([]any); ok {
					for _, w := range warn {
						obj, _ := w.(map[string]any)
						if k, ok := obj["k"].(string); ok {
							keys = append(keys, k)
						}
					}
				}
				s.mu.Lock()
				s.confirm = keys
				s.confirmAt = time.Now()
				s.confirmPending = true
				s.mu.Unlock()
			} else if tp == "evt:brew:confirm:cancel" {
				// Any UI declined: the prompt is gone for everyone.
				s.mu.Lock()
				s.clearBrewConfirmLocked()
				s.mu.Unlock()
			} else if tp == "evt:history-shot-saved" {
				// Firmware v1.9.0+ announces a new history shot here (#1409). Read
				// the hook under mu, then call it unlocked; it must not block because
				// it runs on this read loop. This frame never touches the status cache.
				c.mu.Lock()
				hook := c.onShotSaved
				c.mu.Unlock()
				if hook != nil {
					hook()
				}
			} else if tp == "res:ota-settings" {
				// The controller's reply to the version request sent on connect
				// (and its unsolicited pushes). Handled before the generic res:
				// branch because this frame has no rid and no inflight waiter.
				if v, ok := msg["displayVersion"].(string); ok && v != "" {
					s.mu.Lock()
					s.version = v
					s.mu.Unlock()
				}
			} else if strings.HasPrefix(tp, "res:") {
				s.dispatchResponse(msg)
			}

		case frame := <-s.outgoing:
			// Drop a control frame whose TTL passed while it sat queued — e.g.
			// queued during a disconnect and only drained after a reconnect
			// (#1324). Profile frames carry a zero expiry and are never dropped.
			if frame.expired(time.Now()) {
				continue
			}
			if err := conn.Write(ctx, websocket.MessageText, frame.data); err != nil {
				return
			}

		case <-readErrCh:
			return

		case <-ctx.Done():
			return
		}
	}
}

// gaggiMateBrewing reports whether a merged evt:status describes a running
// brew, using the same process rule as gaggiMateAdapter.GetStatus: process.a==1
// with a brew/infusion stage, and process.u!=1 (a utility process is a flush,
// not a brew). It feeds the machine-traffic counter's idle/brewing split.
func gaggiMateBrewing(status map[string]any) bool {
	process, ok := status["process"].(map[string]any)
	if !ok || looseFloat(process["a"]) != 1 || looseFloat(process["u"]) == 1 {
		return false
	}
	stage, _ := process["s"].(string)
	return stage == "brew" || stage == "infusion"
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

// gaggimateRID formats an incoming rid for comparison against the string rid
// we stored when sending. A numeric rid arrives as float64 and fmt.Sprint would
// render a large one in scientific notation (1.23456789e+08), which never
// matched our integer rid — so format float64 exactly, without an exponent.
func gaggimateRID(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

func (s *gaggiMateLiveSession) dispatchResponse(msg map[string]any) {
	tp, _ := msg["tp"].(string)
	msgRID := gaggimateRID(msg["rid"])
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
// Profile requests never expire (ttl 0).
func (c *gaggiMateLiveClient) Request(ctx context.Context, baseURL, reqType string, payload map[string]any) (map[string]any, error) {
	return c.request(ctx, baseURL, reqType, payload, 0)
}

// request is Request's implementation, extended with a frame TTL. A positive
// ttl bounds how long the frame may sit queued before the writer drops it
// (#1324); ttl 0 means the frame must always be sent.
func (c *gaggiMateLiveClient) request(ctx context.Context, baseURL, reqType string, payload map[string]any, ttl time.Duration) (map[string]any, error) {
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

	var expires time.Time
	if ttl > 0 {
		expires = time.Now().Add(ttl)
	}

	s := c.session(baseURL)
	result := make(chan map[string]any, 1)
	req := &gaggimateInflightReq{resType: resType, rid: fmt.Sprint(rid), result: result}
	s.addInflight(req)
	defer s.removeInflight(req)

	select {
	case s.outgoing <- gaggimateOutgoingFrame{data: body, expires: expires}:
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

// peek returns the existing session for baseURL without creating one and
// without touching its idle timer — control state must never keep a session
// alive on its own (#1324). Returns nil when no session exists.
func (c *gaggiMateLiveClient) peek(baseURL string) *gaggiMateLiveSession {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessions[baseURL]
}

// gaggimateControlFrameTTL bounds how long a machine-control frame may sit
// queued before it is dropped, so a command issued against a machine that was
// down cannot fire after a later reconnect (#1324).
const gaggimateControlFrameTTL = 3 * time.Second

// controlRequest sends a control frame through an already-existing, connected
// session. It deliberately never opens a session: opt-in control must not dial
// a machine on its own (the live client is GLP's only WS connection to a
// GaggiMate). A missing session or a disconnected one is reported as
// errGaggiMateNotConnected.
func (c *gaggiMateLiveClient) controlRequest(ctx context.Context, baseURL, reqType string) (map[string]any, error) {
	s := c.peek(baseURL)
	if s == nil || !s.isConnected() {
		return nil, errGaggiMateNotConnected
	}
	return c.request(ctx, baseURL, reqType, nil, gaggimateControlFrameTTL)
}

// controlSend enqueues a fire-and-forget control frame through an
// already-existing, connected session. The frame gets no rid and no response is
// awaited — the confirm/cancel/activate frames the firmware answers with no
// response frame (#1324). Like controlRequest it never opens a session, so a
// missing one is errGaggiMateNotConnected.
func (c *gaggiMateLiveClient) controlSend(ctx context.Context, baseURL string, frame map[string]any) error {
	s := c.peek(baseURL)
	if s == nil || !s.isConnected() {
		return errGaggiMateNotConnected
	}
	body, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	select {
	case s.outgoing <- gaggimateOutgoingFrame{data: body, expires: time.Now().Add(gaggimateControlFrameTTL)}:
		return nil
	case <-s.done:
		return fmt.Errorf("live session closed before sending control frame")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// isConnected reports whether this session currently holds a live WS
// connection.
func (s *gaggiMateLiveSession) isConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

// brewConfirmTTL bounds how long an unanswered evt:brew:confirm prompt stays
// live. A pending confirm older than this is treated as cleared, so a stale
// prompt can never be confirmed into a brew (#1324). A var so tests can
// shorten it.
var brewConfirmTTL = 60 * time.Second

// controlSnapshot returns the cached evt:status, firmware version, and any
// pending brew-confirmation warning keys for baseURL, but only when a session
// exists, is currently connected, and its status is fresh. The confirm slice is
// a copy (nil when no prompt is pending). It never creates a session or touches
// the idle timer (#1324) — unlike Status, which lazily opens one.
func (c *gaggiMateLiveClient) controlSnapshot(baseURL string) (status map[string]any, version string, confirm []string, ok bool) {
	s := c.peek(baseURL)
	if s == nil {
		return nil, "", nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.connected || s.status == nil || freshOrNilAt(s.statusAt) {
		return nil, "", nil, false
	}
	if s.confirmPending {
		if time.Since(s.confirmAt) > brewConfirmTTL {
			s.clearBrewConfirmLocked()
		} else {
			confirm = make([]string, len(s.confirm))
			copy(confirm, s.confirm)
		}
	}
	return s.status, s.version, confirm, true
}

// clearBrewConfirmLocked drops any pending brew confirmation. Must be called
// with s.mu held.
func (s *gaggiMateLiveSession) clearBrewConfirmLocked() {
	s.confirm = nil
	s.confirmAt = time.Time{}
	s.confirmPending = false
}

// clearBrewConfirm drops any pending brew confirmation on baseURL's existing
// session. A missing session is a no-op (#1324).
func (c *gaggiMateLiveClient) clearBrewConfirm(baseURL string) {
	s := c.peek(baseURL)
	if s == nil {
		return
	}
	s.mu.Lock()
	s.clearBrewConfirmLocked()
	s.mu.Unlock()
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
