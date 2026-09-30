package orders

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
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

// TestContract_QueueEtaShape pins openapi.yaml's QueueEta schema: a rolling
// prep-time estimate plus a position for every pending order.
func TestContract_QueueEtaShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	placeTestOrder(t, mux, nil) // one pending order -> one queue position

	body := decodeBody(t, doJSON(t, mux, http.MethodGet, "/api/orders/queue-eta", nil).Body.Bytes())
	requireNumberKey(t, body, "acceptedRemaining")
	requireNumberKey(t, body, "pendingCount")
	requireNumberKey(t, body, "prepTime")

	positions, ok := body["positions"].(map[string]any)
	if !ok {
		t.Fatalf("positions = %T (%v), want an object", body["positions"], body["positions"])
	}
	if len(positions) != 1 {
		t.Fatalf("positions = %+v, want the one pending order", positions)
	}
	for _, p := range positions {
		entry, ok := p.(map[string]any)
		if !ok {
			t.Fatalf("positions entry = %T (%v), want an object", p, p)
		}
		requireNumberKey(t, entry, "position")
		requireNumberKey(t, entry, "suggestedEta")
	}
}

// TestContract_OrderStatsShape pins openapi.yaml's OrderStats schema on a
// completed-order rollup: total/customers/mostPopular/byMachine.
func TestContract_OrderStatsShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	order := placeTestOrder(t, mux, nil)
	id, _ := order["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", nil)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/complete", nil)

	body := decodeBody(t, doJSON(t, mux, http.MethodGet, "/api/orders/stats", nil).Body.Bytes())
	requireNumberKey(t, body, "total")

	customers, ok := body["customers"].([]any)
	if !ok {
		t.Fatalf("customers = %T (%v), want an array", body["customers"], body["customers"])
	}
	if len(customers) == 0 {
		t.Fatal("expected at least one customer after a completed order")
	}
	first, ok := customers[0].(map[string]any)
	if !ok {
		t.Fatalf("customers[0] = %T (%v), want an object", customers[0], customers[0])
	}
	requireStringKey(t, first, "name")
	requireNumberKey(t, first, "count")
	requireNullableStringKey(t, first, "favItem")
	requireNumberKey(t, first, "lastAt")

	if _, present := body["mostPopular"]; !present {
		t.Error("expected required key \"mostPopular\"")
	}
	if mp, ok := body["mostPopular"].(map[string]any); ok {
		requireStringKey(t, mp, "item")
		requireNumberKey(t, mp, "count")
	}
	if _, present := body["byMachine"]; !present {
		t.Error("expected required key \"byMachine\"")
	}
}

// TestContract_MilkStockShape pins openapi.yaml's MilkStock schema (a Milk
// entity plus the required order-derived demand/remaining) on
// GET /api/orders/milk-stock.
func TestContract_MilkStockShape(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	if err := library.NewRepository(sqlDB).SaveLibrary(library.Library{Milks: []library.Entity{
		{"id": int64(1), "name": "Whole Milk", "emoji": "🥛", "stockMl": 1000.0, "updatedAt": int64(1)},
	}}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rows := decodeBodyArray(t, doJSON(t, mux, http.MethodGet, "/api/orders/milk-stock", nil).Body.Bytes())
	if len(rows) == 0 {
		t.Fatal("expected the seeded milk in GET /api/orders/milk-stock")
	}
	row := rows[0]
	requireNumberKey(t, row, "id")
	requireStringKey(t, row, "name")
	requireNumberKey(t, row, "demand")
	requireNumberKey(t, row, "remaining")
}
