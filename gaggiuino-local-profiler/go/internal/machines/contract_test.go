package machines

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// This file pins GET /api/machines against openapi.yaml's Machine schema —
// the same "pin the essential shape, not the whole grammar" approach
// shots/contract_test.go applies.

// TestContract_MachineShape pins every key openapi.yaml's Machine schema marks
// required (all of them — the struct has no omitempty) on the list response.
func TestContract_MachineShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decoding machines list %q: %v", rec.Body.String(), err)
	}
	if len(list) == 0 {
		t.Fatal("expected the seeded default machine in GET /api/machines")
	}
	for _, m := range list {
		requireNumberField(t, m, "id")
		requireStringField(t, m, "name")
		requireStringField(t, m, "type")
		requireStringField(t, m, "host")
		requireNullableStringField(t, m, "switchEntity")
		requireNullableObjectField(t, m, "theme")
		requireBoolField(t, m, "hasWaterSensor")
		requireBoolField(t, m, "isDefault")
		requireBoolField(t, m, "enabled")
		requireNumberField(t, m, "createdAt")
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

func requireNullableStringField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(string); !ok {
		t.Errorf("expected %q to be a string or null, got %T (%v)", key, v, v)
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

// TestContract_MachineProfileListShape pins openapi.yaml's MachineProfileList
// schema on GET /api/machine/profiles, including one optionsRaw row.
func TestContract_MachineProfileListShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (unreachable)
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/profile",
		strings.NewReader(`{"name":"Offline Profile","phases":[{"type":"PRESSURE"}]}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create profile status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	list := decodeBody(t, rec.Body.Bytes())
	requireBoolField(t, list, "available")
	requireBoolField(t, list, "stale")
	requireNullableStringField(t, list, "current")
	requireNullableNumberField(t, list, "currentId")
	requireStringArrayField(t, list, "options")

	optionsRaw, ok := list["optionsRaw"].([]any)
	if !ok {
		t.Fatalf("optionsRaw = %T (%v), want an array", list["optionsRaw"], list["optionsRaw"])
	}
	if len(optionsRaw) == 0 {
		t.Fatal("expected the locally-created profile in optionsRaw")
	}
	first, ok := optionsRaw[0].(map[string]any)
	if !ok {
		t.Fatalf("optionsRaw[0] = %T (%v), want an object", optionsRaw[0], optionsRaw[0])
	}
	requireStringField(t, first, "id")
	requireStringField(t, first, "name")
	requireBoolField(t, first, "utility")
	requireStringField(t, first, "syncStatus")
}

// TestContract_FirmwareVersionShape pins openapi.yaml's FirmwareVersion
// schema. The default machine is unreachable, so the handler's degraded 200
// (all-null version fields) is what this sees.
func TestContract_FirmwareVersionShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machines", nil)) // seed default (unreachable)
	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/firmware/version", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	requireNullableStringField(t, body, "installed")
	requireNullableStringField(t, body, "latest")
	requireBoolField(t, body, "updateAvailable")
	requireNullableStringField(t, body, "releaseUrl")
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

func requireStringArrayField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.([]any); !ok {
		t.Errorf("expected %q to be an array, got %T (%v)", key, v, v)
	}
}
