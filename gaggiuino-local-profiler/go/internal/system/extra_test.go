package system

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// ── GET /api/switch, POST /api/switch/toggle (Phase 2a) ────────────────

func TestGetSwitch_NotConfigured(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/switch")
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["configured"] != false {
		t.Errorf("configured = %v, want false", body["configured"])
	}
}

func TestGetSwitch_ConfiguredHADisabled(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	se := "switch.gaggia"
	if _, err := machines.NewRegistry(sqlDB).UpdateMachine(1, machines.MachineInput{SwitchEntity: &se}, nil); err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	h := NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken)
	rec := doGet(newSystemMux(h), "/api/switch")
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["configured"] != true {
		t.Errorf("configured = %v, want true", body["configured"])
	}
	if body["entity"] != se {
		t.Errorf("entity = %v, want %q", body["entity"], se)
	}
	// HA disabled -> getSwitchState returns nil -> state is JSON null.
	if v, present := body["state"]; !present || v != nil {
		t.Errorf("state = %v (present %v), want null", v, present)
	}
}

func TestPostSwitchToggle_NotConfigured(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doPost(mux, "/api/switch/toggle", "")
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := decodeMap(t, rec.Body.Bytes())
	if body["error"] != "switch_entity nicht konfiguriert" {
		t.Errorf("error = %v", body["error"])
	}
}

// ── GET /api/openapi.json (Phase 2a) ──────────────────────────────────

func TestGetOpenAPI(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)
	rec := doGet(mux, "/api/openapi.json")
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if doc["openapi"] == nil {
		t.Errorf("converted spec missing top-level `openapi` key")
	}
	if _, ok := doc["paths"].(map[string]any); !ok {
		t.Errorf("converted spec missing `paths` object")
	}
}

// TestOpenAPICopyInSync fails the moment go/internal/system/openapi.yaml
// drifts from the repo-root source of truth it's a committed copy of (see
// openapi.go's header comment).
func TestOpenAPICopyInSync(t *testing.T) {
	source, err := os.ReadFile("../../../openapi.yaml")
	if err != nil {
		t.Fatalf("reading repo-root openapi.yaml: %v", err)
	}
	if string(source) != string(openAPIYAML) {
		t.Fatalf("go/internal/system/openapi.yaml is out of sync with ../../../openapi.yaml — re-copy it")
	}
}

// ── POST /api/sync (Phase 2a) ─────────────────────────────────────────

func TestPostSync_CooldownAfterFirstCall(t *testing.T) {
	_, mux, _ := newFullTestHandlers(t)

	rec := doPost(mux, "/api/sync", "")
	if rec.Code != 200 {
		t.Fatalf("first call status = %d, want 200", rec.Code)
	}
	if body := decodeMap(t, rec.Body.Bytes()); body["ok"] != true {
		t.Errorf("first call body = %v, want {ok:true}", body)
	}

	rec2 := doPost(mux, "/api/sync", "")
	if rec2.Code != 429 {
		t.Fatalf("second (immediate) call status = %d, want 429", rec2.Code)
	}
	if body := decodeMap(t, rec2.Body.Bytes()); body["error"] != "Bitte 30 Sekunden zwischen manuellen Syncs warten." {
		t.Errorf("second call error = %v", body["error"])
	}
}
