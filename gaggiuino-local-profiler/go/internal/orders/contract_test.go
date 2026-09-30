package orders

import (
	"net/http"
	"testing"
)

// This file pins routes/orders.js's responses against openapi.yaml's Order
// (required: [id, createdAt, customer, item, status], status enum
// [pending, accepted, done, declined]) and MenuItem (required: [id, name,
// emoji]) schemas — the same "pin the essential shape, not the whole
// grammar" structural check shots/contract_test.go established.

func requireField(t *testing.T, body map[string]any, key string, kind string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	switch kind {
	case "string":
		if _, ok := v.(string); !ok {
			t.Errorf("expected %q to be a string, got %T (%v)", key, v, v)
		}
	case "number":
		if _, ok := v.(float64); !ok {
			t.Errorf("expected %q to be a number, got %T (%v)", key, v, v)
		}
	}
}

var validOrderStatuses = map[string]bool{"pending": true, "accepted": true, "done": true, "declined": true}

func requireOrderShape(t *testing.T, order map[string]any) {
	t.Helper()
	requireField(t, order, "id", "string")
	requireField(t, order, "createdAt", "number")
	requireField(t, order, "customer", "string")
	requireField(t, order, "item", "string")
	requireField(t, order, "status", "string")
	if status, _ := order["status"].(string); !validOrderStatuses[status] {
		t.Errorf("status %q is not one of the enum values [pending, accepted, done, declined]", status)
	}
}

func TestContract_OrderShape_AcrossLifecycle(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	placed := placeTestOrder(t, mux, nil)
	requireOrderShape(t, placed)

	id, _ := placed["id"].(string)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", mustMarshal(t, map[string]any{"eta": 5}))
	requireOrderShape(t, decodeBody(t, rec.Body.Bytes()))

	rec = doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/complete", nil)
	requireOrderShape(t, decodeBody(t, rec.Body.Bytes()))

	declinedOrder := placeTestOrder(t, mux, nil)
	declineID, _ := declinedOrder["id"].(string)
	rec = doJSON(t, mux, http.MethodPost, "/api/orders/"+declineID+"/decline", mustMarshal(t, map[string]any{"reason": "no beans"}))
	requireOrderShape(t, decodeBody(t, rec.Body.Bytes()))

	// GET /api/orders (list) must return the same Order shape per entry.
	rec = doJSON(t, mux, http.MethodGet, "/api/orders", nil)
	for _, order := range decodeBodyArray(t, rec.Body.Bytes()) {
		requireOrderShape(t, order)
	}
}

func TestContract_MenuItemShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders/menu", nil)
	for _, item := range decodeBodyArray(t, rec.Body.Bytes()) {
		requireField(t, item, "id", "string")
		requireField(t, item, "name", "string")
		requireField(t, item, "emoji", "string")
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/orders/menu", mustMarshal(t, map[string]any{"name": "Cortado Deluxe"}))
	requireField(t, decodeBody(t, rec.Body.Bytes()), "id", "string")
	requireField(t, decodeBody(t, rec.Body.Bytes()), "name", "string")
	requireField(t, decodeBody(t, rec.Body.Bytes()), "emoji", "string")
}

func requireStringKey(t *testing.T, o map[string]any, key string) {
	t.Helper()
	v, ok := o[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, o)
		return
	}
	if _, ok := v.(string); !ok {
		t.Errorf("expected %q to be a string, got %T (%v)", key, v, v)
	}
}

func requireNullableStringKey(t *testing.T, o map[string]any, key string) {
	t.Helper()
	v, ok := o[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, o)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(string); !ok {
		t.Errorf("expected %q to be a string or null, got %T (%v)", key, v, v)
	}
}

func requireNumberKey(t *testing.T, o map[string]any, key string) {
	t.Helper()
	v, ok := o[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, o)
		return
	}
	if _, ok := v.(float64); !ok {
		t.Errorf("expected %q to be a number, got %T (%v)", key, v, v)
	}
}

func requireNullableNumberKey(t *testing.T, o map[string]any, key string) {
	t.Helper()
	v, ok := o[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, o)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(float64); !ok {
		t.Errorf("expected %q to be a number or null, got %T (%v)", key, v, v)
	}
}

// TestContract_OrderRequiredKeys pins every key openapi.yaml's Order schema
// marks required, on both the create response and the GET /api/orders list
// (haUserId and shotId stay optional).
func TestContract_OrderRequiredKeys(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	placed := placeTestOrder(t, mux, nil)
	requireOrderRequiredKeys(t, placed)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders", nil)
	orders := decodeBodyArray(t, rec.Body.Bytes())
	if len(orders) == 0 {
		t.Fatal("expected at least one order in GET /api/orders")
	}
	for _, o := range orders {
		requireOrderRequiredKeys(t, o)
	}
}

func requireOrderRequiredKeys(t *testing.T, o map[string]any) {
	t.Helper()
	requireStringKey(t, o, "id")
	requireNumberKey(t, o, "createdAt")
	requireStringKey(t, o, "customer")
	requireStringKey(t, o, "item")
	requireNullableStringKey(t, o, "variant")
	requireStringKey(t, o, "note")
	requireNullableStringKey(t, o, "notifyService")
	requireNullableStringKey(t, o, "machine")
	requireNumberKey(t, o, "machineId")
	requireStringKey(t, o, "status")
	requireNullableNumberKey(t, o, "eta")
	requireNullableNumberKey(t, o, "acceptedAt")
	requireNullableNumberKey(t, o, "completedAt")
	requireNullableStringKey(t, o, "declineReason")
	requireNullableNumberKey(t, o, "beanId")
}
