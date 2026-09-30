package maintenance

import (
	"net/http"
	"testing"
)

// This file pins GET /api/maintenance's per-task shape against openapi.yaml's
// MaintenanceTask schema — the same "pin the essential shape, not the whole
// grammar" approach shots/contract_test.go applies.

// TestContract_MaintenanceTaskShape pins every key openapi.yaml's
// MaintenanceTask schema marks required (lastDate, threshold_shots,
// threshold_days, daysSince, shotsSince, pct, status) plus the status enum.
func TestContract_MaintenanceTaskShape(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/maintenance", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	tasks := decodeBody(t, rec.Body.Bytes())
	if len(tasks) == 0 {
		t.Fatal("expected the seeded default maintenance tasks")
	}
	for name, raw := range tasks {
		task, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("task %q: expected an object, got %T", name, raw)
		}
		requireTaskShape(t, task)
	}
}

func requireTaskShape(t *testing.T, task map[string]any) {
	t.Helper()
	requireNullableStringField(t, task, "lastDate")
	requireNullableNumberField(t, task, "threshold_shots")
	requireNullableNumberField(t, task, "threshold_days")
	requireNullableNumberField(t, task, "daysSince")
	requireNumberField(t, task, "shotsSince")
	requireNumberField(t, task, "pct")
	status, ok := task["status"].(string)
	if !ok {
		t.Fatalf("expected status to be a string, got %T (%v)", task["status"], task["status"])
	}
	switch status {
	case "never", "ok", "soon", "due":
	default:
		t.Errorf("unexpected maintenance status %q", status)
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
