package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
)

// This file pins the wire contract of routes/system.js's machine-switch and
// openapi endpoints — the "pin the essential shape" check
// orders/shots/library's contract_test.go established. The not-configured
// branches and the openapi-copy-in-sync guard live in extra_test.go; this
// file pins the happy paths that need a (fake-server-backed) HA client.

// fakeHA points a real ha.Client at an httptest server, the GLP_HA_URL
// standalone-Docker path (#764) — see internal/ha/client_test.go's
// newTestClient, reproduced here because it's unexported.
func fakeHA(t *testing.T, h http.HandlerFunc) *ha.Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", srv.URL)
	t.Setenv("GLP_HA_TOKEN", "test-token")
	return ha.NewClientFromEnv()
}

// TestContract_Switch_GetReportsState: with a switch entity configured and
// HA reachable, GET /api/switch reports { configured: true, entity, state }
// where state is the real bool from HA.
func TestContract_Switch_GetReportsState(t *testing.T) {
	haClient := fakeHA(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/states/switch.machine" {
			_ = json.NewEncoder(w).Encode(map[string]string{"state": "on"})
			return
		}
		t.Errorf("unexpected HA call: %s %s", r.Method, r.URL.Path)
	})
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, &fakeAdapter{}, sqlDB, haClient, "switch.machine")
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))

	body := decodeMap(t, doGet(mux, "/api/switch").Body.Bytes())
	if body["configured"] != true || body["entity"] != "switch.machine" {
		t.Fatalf("body = %v", body)
	}
	if body["state"] != true {
		t.Errorf("state = %v, want true", body["state"])
	}
}

// TestContract_SwitchToggle_HappyPath: POST /api/switch/toggle reads the
// current state, calls the opposite switch service, and answers
// { ok: true, state: <new state> }.
func TestContract_SwitchToggle_HappyPath(t *testing.T) {
	var called atomic.Value // string
	haClient := fakeHA(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/states/switch.machine":
			_ = json.NewEncoder(w).Encode(map[string]string{"state": "off"})
		case r.Method == http.MethodPost && r.URL.Path == "/api/services/switch/turn_on":
			called.Store("turn_on")
			_, _ = w.Write([]byte("[]"))
		default:
			t.Errorf("unexpected HA call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, &fakeAdapter{}, sqlDB, haClient, "switch.machine")
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))

	rec := doPost(mux, "/api/switch/toggle", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["ok"] != true || body["state"] != true {
		t.Errorf("body = %v, want {ok:true, state:true}", body)
	}
	if called.Load() != "turn_on" {
		t.Errorf("HA service called = %v, want turn_on (off -> on)", called.Load())
	}
}

// TestContract_OpenAPI_JSONContentType: GET /api/openapi.json serves the
// repo-root spec converted to JSON with a JSON content type.
func TestContract_OpenAPI_JSONContentType(t *testing.T) {
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, &fakeAdapter{}, sqlDB, newDisabledHAClient(), "switch.machine")
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))

	rec := doGet(mux, "/api/openapi.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if _, ok := doc["paths"].(map[string]any); !ok {
		t.Errorf("converted spec missing paths object")
	}
}
