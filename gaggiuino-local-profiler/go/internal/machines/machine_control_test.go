package machines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

// fakeControlGaggiMate is a fake GaggiMate controller for the opt-in
// machine-control tests (#1324). It records every received frame, answers
// req:ota-settings with a configurable displayVersion (empty = no answer),
// pushes a configurable evt:status every ~10ms, and answers
// req:flush:start / req:flush:stop with res:* echoing the rid as the received
// number (the shape the real firmware sends).
type fakeControlGaggiMate struct {
	*httptest.Server

	mu       sync.Mutex
	version  string
	status   map[string]any
	received []map[string]any
	// wsConn is the most recently accepted connection, so a test can push
	// arbitrary frames (e.g. evt:brew:confirm) or drop it to force a reconnect.
	wsConn *websocket.Conn

	conns atomic.Int64
}

func newFakeControlGaggiMate() *fakeControlGaggiMate {
	f := &fakeControlGaggiMate{
		version: "v1.9.0",
		status:  map[string]any{"tp": "evt:status", "m": 1.0, "sys": map[string]any{"s": "ready"}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", f.handleWS)
	f.Server = httptest.NewServer(mux)
	return f
}

func (f *fakeControlGaggiMate) setVersion(v string) {
	f.mu.Lock()
	f.version = v
	f.mu.Unlock()
}

func (f *fakeControlGaggiMate) setStatus(s map[string]any) {
	f.mu.Lock()
	f.status = s
	f.mu.Unlock()
}

// receivedType reports whether any frame of this tp has been received.
func (f *fakeControlGaggiMate) receivedType(tp string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.received {
		if m["tp"] == tp {
			return true
		}
	}
	return false
}

// framesOfType returns a copy of every received frame of this tp, in order.
func (f *fakeControlGaggiMate) framesOfType(tp string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, m := range f.received {
		if m["tp"] == tp {
			out = append(out, m)
		}
	}
	return out
}

// push writes an arbitrary frame to the most recent open connection, so tests
// can drive events the real controller sends unsolicited (evt:brew:confirm,
// evt:brew:confirm:cancel).
func (f *fakeControlGaggiMate) push(frame map[string]any) {
	f.mu.Lock()
	conn := f.wsConn
	f.mu.Unlock()
	if conn == nil {
		return
	}
	b, _ := json.Marshal(frame)
	_ = conn.Write(context.Background(), websocket.MessageText, b)
}

// dropConn closes the most recent connection, forcing the live client to
// reconnect.
func (f *fakeControlGaggiMate) dropConn() {
	f.mu.Lock()
	conn := f.wsConn
	f.mu.Unlock()
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}

func (f *fakeControlGaggiMate) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	f.conns.Add(1)
	f.mu.Lock()
	f.wsConn = conn
	f.mu.Unlock()
	defer conn.CloseNow()
	ctx := r.Context()

	// Push the current evt:status on its own cadence, like the real controller.
	go func() {
		t := time.NewTicker(10 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				f.mu.Lock()
				b, _ := json.Marshal(f.status)
				f.mu.Unlock()
				if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		f.mu.Lock()
		f.received = append(f.received, msg)
		version := f.version
		f.mu.Unlock()

		tp, _ := msg["tp"].(string)
		switch tp {
		case "req:ota-settings":
			if version == "" {
				continue
			}
			b, _ := json.Marshal(map[string]any{"tp": "res:ota-settings", "displayVersion": version})
			_ = conn.Write(ctx, websocket.MessageText, b)
		case "req:flush:start", "req:flush:stop":
			// Echo the rid as the received number, exactly like the firmware.
			b, _ := json.Marshal(map[string]any{
				"tp":      "res:" + tp[len("req:"):],
				"rid":     msg["rid"],
				"success": true,
			})
			_ = conn.Write(ctx, websocket.MessageText, b)
		}
	}
}

func TestParseGaggiMateVersion(t *testing.T) {
	tests := []struct {
		in      string
		maj     int
		min     int
		patch   int
		ok      bool
		control bool
	}{
		{"v1.9.0", 1, 9, 0, true, true},
		{"v1.9.0-12-gabc", 1, 9, 0, true, true},
		{"1.10.2", 1, 10, 2, true, true},
		{"v2.0.0", 2, 0, 0, true, true},
		{"v1.9", 1, 9, 0, true, true},
		{"v1.8.1", 1, 8, 1, true, false},
		{"", 0, 0, 0, false, false},
		{"nightly", 0, 0, 0, false, false},
	}
	for _, tc := range tests {
		maj, min, patch, ok := parseGaggiMateVersion(tc.in)
		if ok != tc.ok || (ok && (maj != tc.maj || min != tc.min || patch != tc.patch)) {
			t.Errorf("parseGaggiMateVersion(%q) = (%d,%d,%d,%v), want (%d,%d,%d,%v)",
				tc.in, maj, min, patch, ok, tc.maj, tc.min, tc.patch, tc.ok)
		}
		if got := gaggiMateControlFirmware(tc.in); got != tc.control {
			t.Errorf("gaggiMateControlFirmware(%q) = %v, want %v", tc.in, got, tc.control)
		}
	}
}

func TestGaggiMateOutgoingFrameExpiry(t *testing.T) {
	now := time.Now()
	if (gaggimateOutgoingFrame{data: []byte("x")}).expired(now) {
		t.Fatal("a zero-expiry frame must never expire")
	}
	if !(gaggimateOutgoingFrame{data: []byte("x"), expires: now.Add(-time.Second)}).expired(now) {
		t.Fatal("a past-expiry frame must expire")
	}
	if (gaggimateOutgoingFrame{data: []byte("x"), expires: now.Add(time.Second)}).expired(now) {
		t.Fatal("a future frame must not expire yet")
	}
}

// warmControlSession opens a persistent session against host and waits until
// the given firmware version has been cached via res:ota-settings.
func warmControlSession(t *testing.T, lc *gaggiMateLiveClient, host, want string) {
	t.Helper()
	lc.Status(host)
	waitUntil(t, 2*time.Second, func() bool {
		_, v, _, ok := lc.controlSnapshot(host)
		return ok && v == want
	})
}

func TestGaggiMateLiveClient_RequestsOTASettingsOnConnect(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeControlGaggiMate()
	defer fake.Close()

	lc := newGaggiMateLiveClient()
	lc.idleTimeout = time.Hour
	t.Cleanup(lc.DisconnectAll)

	warmControlSession(t, lc, fake.URL, "v1.9.0")
	if !fake.receivedType("req:ota-settings") {
		t.Fatal("the session did not send req:ota-settings on connect")
	}
	_, v, _, ok := lc.controlSnapshot(fake.URL)
	if !ok || v != "v1.9.0" {
		t.Fatalf("cached version = %q, ok = %v, want %q", v, ok, "v1.9.0")
	}
}

func TestControlStateFor_Gates(t *testing.T) {
	allowLoopbackMachineHost(t)

	// Gaggiuino: no machine control capability.
	h, registry, sqlDB := newTestHandlers(t)
	gagg := testMachine("http://127.0.0.1:1")
	if _, err := ControlStateFor(registry, h.gaggiuino, gagg); err != ErrMachineControlUnsupported {
		t.Fatalf("Gaggiuino machine: err = %v, want ErrMachineControlUnsupported", err)
	}

	// GaggiMate, setting off: disabled before any live check.
	offAdapter := h.gaggimate.(*GaggiMateAdapter)
	if _, err := ControlStateFor(registry, offAdapter, testGaggiMateMachine("http://127.0.0.1:1")); err != ErrMachineControlDisabled {
		t.Fatalf("setting off: err = %v, want ErrMachineControlDisabled", err)
	}
	if err := db.SetKVBool(sqlDB, machineControlKVKey, true); err != nil {
		t.Fatalf("SetKVBool: %v", err)
	}

	// Old firmware: unavailable, even with a connected, fresh session.
	oldFake := newFakeControlGaggiMate()
	oldFake.setVersion("v1.8.1")
	defer oldFake.Close()
	oldLC := newGaggiMateLiveClient()
	oldLC.idleTimeout = time.Hour
	t.Cleanup(oldLC.DisconnectAll)
	oldAdapter := NewGaggiMateAdapter(oldLC)
	warmControlSession(t, oldLC, oldFake.URL, "v1.8.1")
	if _, err := ControlStateFor(registry, oldAdapter, testGaggiMateMachine(oldFake.URL)); err != ErrMachineControlUnavailable {
		t.Fatalf("v1.8.1: err = %v, want ErrMachineControlUnavailable", err)
	}

	// v1.9.0 idle in brew mode: the live-dependent cases.
	fake := newFakeControlGaggiMate()
	defer fake.Close()
	lc := newGaggiMateLiveClient()
	lc.idleTimeout = time.Hour
	t.Cleanup(lc.DisconnectAll)
	a := NewGaggiMateAdapter(lc)
	m := testGaggiMateMachine(fake.URL)
	warmControlSession(t, lc, fake.URL, "v1.9.0")

	waitControl(t, a, m, func(s ControlState) bool { return s.CanFlush })

	// Active brew process: not flushable, not flushing.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "s": "brew"}, "sys": map[string]any{"s": "ready"}})
	waitControl(t, a, m, func(s ControlState) bool { return !s.CanFlush && !s.Flushing })

	// A utility process (flush running): flushing.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "u": 1.0}, "sys": map[string]any{"s": "ready"}})
	waitControl(t, a, m, func(s ControlState) bool { return s.Flushing && !s.CanFlush })

	// Not ready: not flushable even with no active process (process: null
	// clears the previously merged process, matching the firmware).
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": nil, "sys": map[string]any{"s": "heating"}})
	waitControl(t, a, m, func(s ControlState) bool { return !s.CanFlush && !s.Flushing })

	// Ready and idle in brew mode again.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": nil, "sys": map[string]any{"s": "ready"}})
	waitControl(t, a, m, func(s ControlState) bool { return s.CanFlush })

	state, err := ControlStateFor(registry, a, m)
	if err != nil {
		t.Fatalf("ControlStateFor: %v", err)
	}
	if state.MachineID != m.ID {
		t.Fatalf("MachineID = %d, want %d", state.MachineID, m.ID)
	}
}

// waitControl polls until a's ControlState satisfies cond or the deadline.
func waitControl(t *testing.T, a *GaggiMateAdapter, m *Machine, cond func(ControlState) bool) {
	t.Helper()
	waitUntil(t, 2*time.Second, func() bool {
		s, ok := a.ControlState(m)
		return ok && cond(s)
	})
}

func TestMachineControlRoutes_FlushStartStop(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	fake := newFakeControlGaggiMate()
	defer fake.Close()

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	warmControlSession(t, h.gaggimateLive, fake.URL, "v1.9.0")

	post := func(path string) *httptest.ResponseRecorder {
		body := strings.NewReader(`{"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`)
		return doRequest(mux, httptest.NewRequest(http.MethodPost, path, body))
	}

	// Setting off: 403 and no frame reaches the machine.
	rec := post("/api/machine/flush/start")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("flush/start with setting off = %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	if fake.receivedType("req:flush:start") {
		t.Fatal("flush/start frame was sent while machine control was disabled")
	}

	// Turn the setting on: the same request now succeeds and is delivered.
	if err := db.SetKVBool(sqlDB, machineControlKVKey, true); err != nil {
		t.Fatalf("SetKVBool: %v", err)
	}
	rec = post("/api/machine/flush/start")
	if rec.Code != http.StatusOK {
		t.Fatalf("flush/start with setting on = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	waitUntil(t, time.Second, func() bool { return fake.receivedType("req:flush:start") })

	rec = post("/api/machine/flush/stop")
	if rec.Code != http.StatusOK {
		t.Fatalf("flush/stop = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	waitUntil(t, time.Second, func() bool { return fake.receivedType("req:flush:stop") })

	// Gaggiuino machine: 501.
	gm, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Gaggiuino"), Type: strPtr("gaggiuino"), Host: strPtr("http://127.0.0.1:1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine gaggiuino: %v", err)
	}
	reqBody := strings.NewReader(`{"machineId":` + strconv.FormatInt(gm.ID, 10) + `}`)
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/flush/start", reqBody))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("Gaggiuino flush/start = %d, want 501 (body %s)", rec.Code, rec.Body)
	}
}

func TestMachineControlRoutes_UnavailableAndBusy(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	if err := db.SetKVBool(sqlDB, machineControlKVKey, true); err != nil {
		t.Fatalf("SetKVBool: %v", err)
	}

	// Old firmware: 409.
	oldFirmware := newFakeControlGaggiMate()
	oldFirmware.setVersion("v1.8.1")
	defer oldFirmware.Close()
	ofM, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Old"), Type: strPtr("gaggimate"), Host: strPtr(oldFirmware.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	waitUntil(t, 2*time.Second, func() bool {
		h.gaggimateLive.Status(oldFirmware.URL)
		_, _, _, ok := h.gaggimateLive.controlSnapshot(oldFirmware.URL)
		return ok
	})
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/flush/start",
		strings.NewReader(`{"machineId":`+strconv.FormatInt(ofM.ID, 10)+`}`)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("old firmware flush/start = %d, want 409 (body %s)", rec.Code, rec.Body)
	}

	// Busy (active brew): 409.
	busy := newFakeControlGaggiMate()
	busy.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "s": "brew"}, "sys": map[string]any{"s": "ready"}})
	defer busy.Close()
	busyM, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Busy"), Type: strPtr("gaggimate"), Host: strPtr(busy.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	waitUntil(t, 2*time.Second, func() bool {
		h.gaggimateLive.Status(busy.URL)
		_, v, _, ok := h.gaggimateLive.controlSnapshot(busy.URL)
		return ok && v == "v1.9.0"
	})
	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/flush/start",
		strings.NewReader(`{"machineId":`+strconv.FormatInt(busyM.ID, 10)+`}`)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("busy flush/start = %d, want 409 (body %s)", rec.Code, rec.Body)
	}
	if busy.receivedType("req:flush:start") {
		t.Fatal("flush/start frame was sent while the machine was busy")
	}
}

// TestGaggiMateRID covers the numeric-rid formatting that #1324 relies on: a
// 9-digit float64 must format exactly, not as 1.23e+08.
func TestGaggiMateRID(t *testing.T) {
	if got := gaggimateRID(float64(123456789)); got != "123456789" {
		t.Fatalf("gaggimateRID(123456789) = %q, want %q", got, "123456789")
	}
	if got := gaggimateRID("abc"); got != "abc" {
		t.Fatalf("gaggimateRID(string) = %q, want %q", got, "abc")
	}
	if got := gaggimateRID(nil); got != "<nil>" {
		t.Fatalf("gaggimateRID(nil) = %q, want %q", got, "<nil>")
	}
}

// TestControlRequestDoesNotOpenSession covers the peek-not-create invariant:
// a control request against a machine with no session fails without dialing.
func TestControlRequestDoesNotOpenSession(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeControlGaggiMate()
	defer fake.Close()

	lc := newGaggiMateLiveClient()
	lc.idleTimeout = time.Hour
	t.Cleanup(lc.DisconnectAll)

	if _, err := lc.controlRequest(context.Background(), fake.URL, "req:flush:start"); err != errGaggiMateNotConnected {
		t.Fatalf("controlRequest without a session = %v, want errGaggiMateNotConnected", err)
	}
	if n := fake.conns.Load(); n != 0 {
		t.Fatalf("controlRequest opened %d connections, want 0", n)
	}
}

// brewConfirmFrame is the evt:brew:confirm frame the firmware broadcasts when a
// brew start is blocked by error-level warnings (#1324).
func brewConfirmFrame() map[string]any {
	warn := []any{
		map[string]any{"k": "water", "l": 2.0},
		map[string]any{"k": "flush", "l": 1.0},
	}
	return map[string]any{"tp": "evt:brew:confirm", "warn": warn}
}

// newWarmControlAdapter spins up a fake controller, a live client, and an
// adapter whose session is warmed to firmware v1.9.0.
func newWarmControlAdapter(t *testing.T) (*fakeControlGaggiMate, *GaggiMateAdapter, *Machine) {
	t.Helper()
	allowLoopbackMachineHost(t)
	fake := newFakeControlGaggiMate()
	t.Cleanup(fake.Close)
	lc := newGaggiMateLiveClient()
	lc.idleTimeout = time.Hour
	t.Cleanup(lc.DisconnectAll)
	a := NewGaggiMateAdapter(lc)
	m := testGaggiMateMachine(fake.URL)
	warmControlSession(t, lc, fake.URL, "v1.9.0")
	return fake, a, m
}

func TestBrewConfirm_StoredInOrder(t *testing.T) {
	fake, a, m := newWarmControlAdapter(t)

	fake.push(brewConfirmFrame())
	waitControl(t, a, m, func(s ControlState) bool {
		return len(s.BrewConfirm) == 2 && s.BrewConfirm[0] == "water" && s.BrewConfirm[1] == "flush"
	})
}

func TestBrewConfirm_ClearedByCancelEvent(t *testing.T) {
	fake, a, m := newWarmControlAdapter(t)

	fake.push(brewConfirmFrame())
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm != nil })

	fake.push(map[string]any{"tp": "evt:brew:confirm:cancel"})
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm == nil })
}

func TestBrewConfirm_ClearedByActiveProcess(t *testing.T) {
	fake, a, m := newWarmControlAdapter(t)

	fake.push(brewConfirmFrame())
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm != nil })

	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "s": "brew"}, "sys": map[string]any{"s": "ready"}})
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm == nil })
}

func TestBrewConfirm_ClearedByLeavingBrewMode(t *testing.T) {
	fake, a, m := newWarmControlAdapter(t)

	fake.push(brewConfirmFrame())
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm != nil })

	fake.setStatus(map[string]any{"tp": "evt:status", "m": 0.0, "sys": map[string]any{"s": "ready"}})
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm == nil })
}

func TestBrewConfirm_ClearedByReconnect(t *testing.T) {
	fake, a, m := newWarmControlAdapter(t)

	fake.push(brewConfirmFrame())
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm != nil })

	fake.dropConn()
	// The live client reconnects after liveReconnectDelay; a new connection
	// resets the session's status and drops the pending confirmation.
	waitUntil(t, 6*time.Second, func() bool {
		s, ok := a.ControlState(m)
		return ok && s.BrewConfirm == nil
	})
}

func TestBrewConfirm_ExpiresByTTL(t *testing.T) {
	oldTTL := brewConfirmTTL
	brewConfirmTTL = 200 * time.Millisecond
	t.Cleanup(func() { brewConfirmTTL = oldTTL })

	fake, a, m := newWarmControlAdapter(t)

	fake.push(brewConfirmFrame())
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm != nil })
	waitControl(t, a, m, func(s ControlState) bool { return s.BrewConfirm == nil })
}

// newControlRouteFixture builds a Handlers/registry/mux around one fake
// GaggiMate machine with a warmed live session and machine control enabled —
// the common setup for the brew-confirm and flush-stop route tests.
func newControlRouteFixture(t *testing.T) (*Handlers, *Registry, *http.ServeMux, *fakeControlGaggiMate, *Machine) {
	t.Helper()
	allowLoopbackMachineHost(t)
	h, registry, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	fake := newFakeControlGaggiMate()
	t.Cleanup(fake.Close)
	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	warmControlSession(t, h.gaggimateLive, fake.URL, "v1.9.0")
	if err := db.SetKVBool(sqlDB, machineControlKVKey, true); err != nil {
		t.Fatalf("SetKVBool: %v", err)
	}
	return h, registry, mux, fake, machine
}

func controlPost(mux *http.ServeMux, machineID int64, path string) *httptest.ResponseRecorder {
	body := strings.NewReader(`{"machineId":` + strconv.FormatInt(machineID, 10) + `}`)
	return doRequest(mux, httptest.NewRequest(http.MethodPost, path, body))
}

func TestMachineControlRoutes_BrewConfirm(t *testing.T) {
	h, registry, mux, fake, machine := newControlRouteFixture(t)
	ga := h.gaggimate.(*GaggiMateAdapter)

	// Nothing pending: 409 and GLP never sends req:process:activate.
	rec := controlPost(mux, machine.ID, "/api/machine/brew-confirm/confirm")
	if rec.Code != http.StatusConflict {
		t.Fatalf("confirm with nothing pending = %d, want 409 (body %s)", rec.Code, rec.Body)
	}
	if fake.receivedType("req:process:activate") {
		t.Fatal("req:process:activate was sent with no confirmation pending")
	}

	// A pending confirmation: 200 and exactly the ignoreWarnings activate frame.
	fake.push(brewConfirmFrame())
	waitControl(t, ga, machine, func(s ControlState) bool { return s.BrewConfirm != nil })

	rec = controlPost(mux, machine.ID, "/api/machine/brew-confirm/confirm")
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm with a pending confirmation = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	waitUntil(t, time.Second, func() bool { return fake.receivedType("req:process:activate") })
	activate := fake.framesOfType("req:process:activate")
	if len(activate) != 1 {
		t.Fatalf("req:process:activate frames = %d, want 1", len(activate))
	}
	if len(activate[0]) != 2 || !looseTruthy(activate[0]["ignoreWarnings"]) {
		t.Fatalf("activate frame = %v, want {tp, ignoreWarnings:true}", activate[0])
	}
	if s, ok := ga.ControlState(machine); !ok || s.BrewConfirm != nil {
		t.Fatalf("BrewConfirm after confirm = %v (ok %v), want nil", s.BrewConfirm, ok)
	}
	if _, err := ControlStateFor(registry, h.gaggimate, machine); err != nil {
		t.Fatalf("ControlStateFor after confirm: %v", err)
	}

	// Cancel is allowed with nothing pending and delivers the cancel frame.
	rec = controlPost(mux, machine.ID, "/api/machine/brew-confirm/cancel")
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	waitUntil(t, time.Second, func() bool { return fake.receivedType("req:brew:confirm:cancel") })
}

func TestMachineControlRoutes_FlushStopDeactivatesUtility(t *testing.T) {
	h, _, mux, fake, machine := newControlRouteFixture(t)
	ga := h.gaggimate.(*GaggiMateAdapter)

	// A utility process (fixed-length flush) is running: Stop also deactivates.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "u": 1.0}, "sys": map[string]any{"s": "ready"}})
	waitControl(t, ga, machine, func(s ControlState) bool { return s.Flushing })
	rec := controlPost(mux, machine.ID, "/api/machine/flush/stop")
	if rec.Code != http.StatusOK {
		t.Fatalf("flush/stop (utility) = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	waitUntil(t, time.Second, func() bool { return fake.receivedType("req:flush:stop") })
	waitUntil(t, time.Second, func() bool { return len(fake.framesOfType("req:process:deactivate")) == 1 })

	// A brew is running: Stop must never send req:process:deactivate.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "s": "brew"}, "sys": map[string]any{"s": "ready"}})
	waitControl(t, ga, machine, func(s ControlState) bool { return !s.Flushing })
	rec = controlPost(mux, machine.ID, "/api/machine/flush/stop")
	if rec.Code != http.StatusOK {
		t.Fatalf("flush/stop (brew) = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	waitUntil(t, time.Second, func() bool { return len(fake.framesOfType("req:flush:stop")) == 2 })
	if n := len(fake.framesOfType("req:process:deactivate")); n != 1 {
		t.Fatalf("req:process:deactivate frames = %d, want 1 (Stop must not deactivate a brew)", n)
	}
}

func TestMachineControlSettingsRoutes(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/control/settings", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET settings = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	if body := decodeBody(t, rec.Body.Bytes()); body["enabled"] != false {
		t.Fatalf("GET settings default = %v, want false", body["enabled"])
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/control/settings",
		strings.NewReader(`{"enabled":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST settings true = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/control/settings", nil))
	if body := decodeBody(t, rec.Body.Bytes()); body["enabled"] != true {
		t.Fatalf("GET settings after enabling = %v, want true", body["enabled"])
	}

	for _, body := range []string{`{}`, `{"enabled":"yes"}`} {
		rec = doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/control/settings",
			strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST settings %s = %d, want 400 (body %s)", body, rec.Code, rec.Body)
		}
	}
}

func TestMachineControlRoutes_SettingsEnableUnlocksFlush(t *testing.T) {
	allowLoopbackMachineHost(t)
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)
	fake := newFakeControlGaggiMate()
	defer fake.Close()
	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr(fake.URL),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	warmControlSession(t, h.gaggimateLive, fake.URL, "v1.9.0")

	// Machine control off: flush/start is 403.
	if rec := controlPost(mux, machine.ID, "/api/machine/flush/start"); rec.Code != http.StatusForbidden {
		t.Fatalf("flush/start while disabled = %d, want 403 (body %s)", rec.Code, rec.Body)
	}

	// Enable through the settings API: the same request now succeeds.
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/control/settings",
		strings.NewReader(`{"enabled":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST settings = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	if rec := controlPost(mux, machine.ID, "/api/machine/flush/start"); rec.Code != http.StatusOK {
		t.Fatalf("flush/start after enabling = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
}

func TestGaggiMateGetStatus_FlushIsNotABrew(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeControlGaggiMate()
	defer fake.Close()
	lc := newGaggiMateLiveClient()
	lc.idleTimeout = time.Hour
	t.Cleanup(lc.DisconnectAll)
	a := NewGaggiMateAdapter(lc)
	m := testGaggiMateMachine(fake.URL)
	warmControlSession(t, lc, fake.URL, "v1.9.0")

	// A utility process that also reports the brew stage is a flush, not a brew.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "u": 1.0, "s": "brew"}, "sys": map[string]any{"s": "ready"}})
	waitUntil(t, 2*time.Second, func() bool {
		st, err := a.GetStatus(context.Background(), m)
		return err == nil && !st.Brewing
	})

	// The same process without u: a real brew.
	fake.setStatus(map[string]any{"tp": "evt:status", "m": 1.0, "process": map[string]any{"a": 1.0, "s": "brew"}, "sys": map[string]any{"s": "ready"}})
	waitUntil(t, 2*time.Second, func() bool {
		st, err := a.GetStatus(context.Background(), m)
		return err == nil && st.Brewing
	})
}
