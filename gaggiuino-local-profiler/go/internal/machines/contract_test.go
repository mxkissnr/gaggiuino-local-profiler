package machines

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
