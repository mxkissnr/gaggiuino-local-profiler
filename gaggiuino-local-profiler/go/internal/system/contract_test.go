package system

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// This file pins the wire contract of the machine-switch and
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

// TestContract_Switch_UsesRequestedMachine: both switch endpoints honour
// ?machineId (#2202) — a toggle and a read for machine B hit only B's switch
// entity, while the unparameterized GET still reports the default machine's.
func TestContract_Switch_UsesRequestedMachine(t *testing.T) {
	var mu sync.Mutex
	var stateReads, turnOnEntities []string
	haClient := fakeHA(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/states/"):
			entity := strings.TrimPrefix(r.URL.Path, "/api/states/")
			mu.Lock()
			stateReads = append(stateReads, entity)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"state": "off"})
		case r.Method == http.MethodPost && r.URL.Path == "/api/services/switch/turn_on":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			entity, _ := body["entity_id"].(string)
			mu.Lock()
			turnOnEntities = append(turnOnEntities, entity)
			mu.Unlock()
			_, _ = w.Write([]byte("[]"))
		default:
			t.Errorf("unexpected HA call: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, &fakeAdapter{}, sqlDB, haClient, "switch.machine_a")

	name, typ, host, se := "Machine B", "gaggimate", "machine-b.invalid", "switch.machine_b"
	machineB, err := p.registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host, SwitchEntity: &se})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))

	rec := doPost(mux, fmt.Sprintf("/api/switch/toggle?machineId=%d", machineB.ID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle status = %d, body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["ok"] != true || body["state"] != true {
		t.Errorf("toggle body = %v, want {ok:true, state:true}", body)
	}

	mu.Lock()
	gotTurnOn := append([]string(nil), turnOnEntities...)
	gotReads := append([]string(nil), stateReads...)
	mu.Unlock()
	if len(gotTurnOn) != 1 || gotTurnOn[0] != "switch.machine_b" {
		t.Errorf("turn_on entities = %v, want exactly [switch.machine_b]", gotTurnOn)
	}
	for _, entity := range gotReads {
		if entity == "switch.machine_a" {
			t.Errorf("state reads = %v, want none for the default machine's switch.machine_a", gotReads)
		}
	}

	rec = doGet(mux, fmt.Sprintf("/api/switch?machineId=%d", machineB.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("switch B status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := decodeMap(t, rec.Body.Bytes())["entity"]; got != "switch.machine_b" {
		t.Errorf("switch?machineId=B entity = %v, want switch.machine_b", got)
	}

	rec = doGet(mux, "/api/switch")
	if rec.Code != http.StatusOK {
		t.Fatalf("switch status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := decodeMap(t, rec.Body.Bytes())["entity"]; got != "switch.machine_a" {
		t.Errorf("switch entity without machineId = %v, want the default machine's switch.machine_a", got)
	}
}

// TestContract_Switch_RejectsBadMachineId: a non-numeric ?machineId is a 400
// and one that names no machine a 404 on both endpoints — never a silent
// fallback to the default machine's switch. A machine without a switch entity
// keeps the existing {configured:false} GET and 400 toggle (#2202).
func TestContract_Switch_RejectsBadMachineId(t *testing.T) {
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, &fakeAdapter{}, sqlDB, newDisabledHAClient(), "switch.machine_a")

	nameC, typC, hostC := "Machine C", "gaggimate", "machine-c.invalid"
	machineC, err := p.registry.CreateMachine(machines.MachineInput{Name: &nameC, Type: &typC, Host: &hostC})
	if err != nil {
		t.Fatalf("CreateMachine C: %v", err)
	}
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))

	if rec := doGet(mux, "/api/switch?machineId=999999"); rec.Code != http.StatusNotFound {
		t.Errorf("GET unknown machineId status = %d, want 404 (body=%s)", rec.Code, rec.Body.String())
	}
	if rec := doPost(mux, "/api/switch/toggle?machineId=999999", ""); rec.Code != http.StatusNotFound {
		t.Errorf("POST unknown machineId status = %d, want 404 (body=%s)", rec.Code, rec.Body.String())
	}
	if rec := doGet(mux, "/api/switch?machineId=abc"); rec.Code != http.StatusBadRequest {
		t.Errorf("GET non-numeric machineId status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if rec := doPost(mux, "/api/switch/toggle?machineId=abc", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("POST non-numeric machineId status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}

	rec := doGet(mux, fmt.Sprintf("/api/switch?machineId=%d", machineC.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET machine without switch entity status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := decodeMap(t, rec.Body.Bytes())["configured"]; got != false {
		t.Errorf("configured = %v, want false for a machine without a switch entity", got)
	}

	rec = doPost(mux, fmt.Sprintf("/api/switch/toggle?machineId=%d", machineC.ID), "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST machine without switch entity status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if got := decodeMap(t, rec.Body.Bytes())["error"]; got != "switch_entity nicht konfiguriert" {
		t.Errorf("error = %v, want switch_entity nicht konfiguriert", got)
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

func requireBoolField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(bool); !ok {
		t.Errorf("expected %q to be a boolean, got %T (%v)", key, v, v)
	}
}

func requireStringField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(string); !ok {
		t.Errorf("expected %q to be a string, got %T (%v)", key, v, v)
	}
}

func requireNumberField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(float64); !ok {
		t.Errorf("expected %q to be a number, got %T (%v)", key, v, v)
	}
}

func requireNullableNumberField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(float64); !ok {
		t.Errorf("expected %q to be a number or null, got %T (%v)", key, v, v)
	}
}

func requireNullableBoolField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(bool); !ok {
		t.Errorf("expected %q to be a boolean or null, got %T (%v)", key, v, v)
	}
}

func requireNullableObjectField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(map[string]any); !ok {
		t.Errorf("expected %q to be an object or null, got %T (%v)", key, v, v)
	}
}

// TestContract_LiveDataShape pins openapi.yaml's LiveData schema (every key
// always present) on GET /api/live/data, the same payload the SSE
// live-snapshot event carries.
func TestContract_LiveDataShape(t *testing.T) {
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, &fakeAdapter{}, sqlDB, newDisabledHAClient(), "switch.machine")
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))

	rec := doGet(mux, "/api/live/data")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())

	requireBoolField(t, body, "isLive")
	requireStringField(t, body, "profileName")
	requireNullableObjectField(t, body, "datapoints")
	requireNumberField(t, body, "seq")
	requireNullableBoolField(t, body, "machineReachable")
	requireBoolField(t, body, "isSteaming")
	requireNumberField(t, body, "steamSeq")
	requireNullableObjectField(t, body, "steamDatapoints")
	requireBoolField(t, body, "isFlushing")
	requireNumberField(t, body, "flushSeq")
	requireNullableObjectField(t, body, "flushDatapoints")
	requireBoolField(t, body, "isDescaling")
	requireNumberField(t, body, "descaleSeq")
	requireNullableObjectField(t, body, "descaleDatapoints")
	requireNullableNumberField(t, body, "temperature")
	requireNullableNumberField(t, body, "targetTemperature")
	requireNullableNumberField(t, body, "pressure")
	requireNullableNumberField(t, body, "waterLevel")
	requireBoolField(t, body, "machineUpdateAvailable")
	requireNullableObjectField(t, body, "machineControl")

	warnings, ok := body["machineWarnings"].([]any)
	if !ok || warnings == nil {
		t.Fatalf("machineWarnings = %v (%T), want non-nil []any", body["machineWarnings"], body["machineWarnings"])
	}
	if len(warnings) != 0 {
		t.Fatalf("machineWarnings = %v, want empty", warnings)
	}
}
