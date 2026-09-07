package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// fakeGaggiMateMachine is a minimal stand-in for a real GaggiMate
// controller's JSON WebSocket surface (gaggimate_ws.go/gaggimate_profiles.go),
// same rationale as fakeGaggiuinoMachine — see that type's doc comment.
type fakeGaggiMateMachine struct {
	*httptest.Server

	mu       sync.Mutex
	profiles []map[string]any
}

func newFakeGaggiMateMachine() *fakeGaggiMateMachine {
	f := &fakeGaggiMateMachine{}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", f.handleWS)
	f.Server = httptest.NewServer(mux)
	return f
}

func (f *fakeGaggiMateMachine) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := r.Context()

	// Push one evt:status frame immediately on connect — waitForStatus()
	// (used by GetStatus) waits for exactly this, unsolicited.
	statusFrame, _ := json.Marshal(map[string]any{"tp": "evt:status", "ct": 92.5, "tt": 93.0, "pr": 8.5, "m": 1, "p": "Espresso", "process": map[string]any{"a": 1, "s": "brew"}})
	_ = conn.Write(ctx, websocket.MessageText, statusFrame)

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var req map[string]any
		if err := json.Unmarshal(data, &req); err != nil {
			continue
		}
		f.respond(ctx, conn, req)
	}
}

func (f *fakeGaggiMateMachine) respond(ctx context.Context, conn *websocket.Conn, req map[string]any) {
	tp, _ := req["tp"].(string)
	// #342, live-verified against real firmware (see gaggimate_ws.go's doc
	// comment): the machine echoes `rid` back as a JSON *string*, even
	// though the client sends it as a number — reproduced here rather than
	// echoing the number straight back, since that's what
	// gaggimateRequest()'s type-tolerant comparison is specifically built
	// to handle. json.Unmarshal decodes the incoming numeric rid into a
	// float64 (encoding/json's default for JSON numbers into `any`); %.0f
	// renders its integer digits without Go's %v scientific-notation
	// switch (which triggers even for ordinary 9-digit magnitudes — the
	// bug this fake's earlier plain-number echo exposed in the first
	// place, see ws.go's comparison).
	rid := fmt.Sprintf("%.0f", req["rid"])
	send := func(resType string, extra map[string]any) {
		frame := map[string]any{"tp": resType, "rid": rid}
		for k, v := range extra {
			frame[k] = v
		}
		b, _ := json.Marshal(frame)
		_ = conn.Write(ctx, websocket.MessageText, b)
	}

	switch tp {
	case "req:profiles:list":
		f.mu.Lock()
		profiles := append([]map[string]any{}, f.profiles...)
		f.mu.Unlock()
		send("res:profiles:list", map[string]any{"profiles": profiles})

	case "req:profiles:load":
		id := req["id"]
		f.mu.Lock()
		var found map[string]any
		for _, p := range f.profiles {
			if fmtEqual(p["id"], id) {
				found = p
				break
			}
		}
		f.mu.Unlock()
		send("res:profiles:load", map[string]any{"profile": found})

	case "req:profiles:save":
		profile, _ := req["profile"].(map[string]any)
		f.mu.Lock()
		if profile["id"] == nil {
			profile["id"] = float64(len(f.profiles) + 1)
			f.profiles = append(f.profiles, profile)
		} else {
			for i, p := range f.profiles {
				if fmtEqual(p["id"], profile["id"]) {
					f.profiles[i] = profile
				}
			}
		}
		f.mu.Unlock()
		send("res:profiles:save", map[string]any{"profile": profile})

	case "req:profiles:delete":
		id := req["id"]
		f.mu.Lock()
		out := f.profiles[:0]
		for _, p := range f.profiles {
			if !fmtEqual(p["id"], id) {
				out = append(out, p)
			}
		}
		f.profiles = out
		f.mu.Unlock()
		send("res:profiles:delete", nil)

	case "req:profiles:select":
		send("res:profiles:select", nil)
	}
}

func fmtEqual(a, b any) bool {
	af, aok := toFloat(a)
	bf, bok := toFloat(b)
	if aok && bok {
		return af == bf
	}
	return a == b
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	default:
		return 0, false
	}
}

// newTestGaggiMateAdapter builds a GaggiMateAdapter whose persistent live
// client uses a short idle timeout and is torn down at test end, so no
// reconnect goroutine outlives the test.
func newTestGaggiMateAdapter(t *testing.T) *GaggiMateAdapter {
	t.Helper()
	lc := newGaggiMateLiveClient()
	lc.idleTimeout = 50 * time.Millisecond
	t.Cleanup(lc.DisconnectAll)
	return NewGaggiMateAdapter(lc)
}
