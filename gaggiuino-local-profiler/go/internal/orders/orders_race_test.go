package orders

import (
	"database/sql"
	"math"
	"net/http"
	"strconv"
	"testing"
)

// rawOrderData reads the un-decoded JSON blob stored for one order, so a test
// can prove a later write left an existing row's bytes untouched.
func rawOrderData(t *testing.T, sqlDB *sql.DB, id string) string {
	t.Helper()
	var data string
	if err := sqlDB.QueryRow(`SELECT data FROM orders WHERE id = ?`, id).Scan(&data); err != nil {
		t.Fatalf("reading raw data for order %s: %v", id, err)
	}
	return data
}

func orderStatus(t *testing.T, repo *Repository, id string) string {
	t.Helper()
	o, err := repo.FindByID(id)
	if err != nil {
		t.Fatalf("FindByID %s: %v", id, err)
	}
	if o == nil {
		t.Fatalf("order %s not found", id)
	}
	status, _ := o["status"].(string)
	return status
}

// TestPlaceOrder_DoesNotResurrectCompletedOrder is the #1607 regression:
// placing a new order must not read the active set and write it back (the old
// FindActive()+SaveAll whole-queue read-modify-write), so an order that was
// completed between a read and the write can never be brought back to pending.
func TestPlaceOrder_DoesNotResurrectCompletedOrder(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	a := placeTestOrder(t, mux, map[string]any{"customer": "A"})
	aID, _ := a["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+aID+"/accept", nil)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+aID+"/complete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("complete status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := orderStatus(t, repo, aID); got != "done" {
		t.Fatalf("A status after complete = %q, want done", got)
	}
	before := rawOrderData(t, sqlDB, aID)

	placeTestOrder(t, mux, map[string]any{"customer": "B"})

	if got := orderStatus(t, repo, aID); got != "done" {
		t.Fatalf("A status after placing B = %q, want done (must not be resurrected)", got)
	}
	if after := rawOrderData(t, sqlDB, aID); after != before {
		t.Fatalf("PlaceOrder rewrote A's stored row:\nbefore = %s\nafter  = %s", before, after)
	}
}

// TestFindAll_OrdersByCreatedAt pins the deterministic ORDER BY: rows come back
// oldest first regardless of the order they were inserted in.
func TestFindAll_OrdersByCreatedAt(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	for _, c := range []int64{3, 1, 2} {
		o := Order{
			"id": "ord_created_" + strconv.FormatInt(c, 10), "createdAt": c, "status": "pending", "machineId": int64(1),
		}
		if err := repo.Insert(o); err != nil {
			t.Fatalf("Insert createdAt=%d: %v", c, err)
		}
	}
	all, err := repo.FindAll()
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("FindAll returned %d orders, want 3", len(all))
	}
	for i, want := range []float64{1, 2, 3} {
		if got, _ := jsNumber(all[i]["createdAt"]); got != want {
			t.Fatalf("FindAll[%d].createdAt = %v, want %v (oldest first)", i, got, want)
		}
	}
}

// TestInsert_DuplicateIDErrors: Insert is not an upsert — a duplicate id is an
// error and must leave the first row intact.
func TestInsert_DuplicateIDErrors(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	first := Order{"id": "ord_dup", "createdAt": int64(1), "status": "pending", "machineId": int64(1)}
	if err := repo.Insert(first); err != nil {
		t.Fatalf("first Insert: %v", err)
	}
	second := Order{"id": "ord_dup", "createdAt": int64(2), "status": "done", "machineId": int64(1)}
	if err := repo.Insert(second); err == nil {
		t.Fatal("second Insert with a duplicate id returned nil, want an error")
	}
	got, err := repo.FindByID("ord_dup")
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if s, _ := got["status"].(string); s != "pending" {
		t.Fatalf("duplicate Insert overwrote the first row: status = %q, want pending", s)
	}
}

func TestMilkMlOrNil(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want any
	}{
		{"negative number", -5.0, nil},
		{"negative string", "-5", nil},
		{"positive infinity", math.Inf(1), nil},
		{"zero", 0.0, nil},
		{"NaN", math.NaN(), nil},
		{"positive number", 30.0, float64(30)},
		{"positive string", "30", float64(30)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := milkMlOrNil(tc.in); got != tc.want {
				t.Errorf("milkMlOrNil(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestMenu_Create_StoresMilkMl pins that the POST menu path stores milkMl, the
// way the PATCH (PUT) path already does.
func TestMenu_Create_StoresMilkMl(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/menu", mustMarshal(t, map[string]any{"name": "Latte", "milkMl": 40}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	item := decodeBody(t, rec.Body.Bytes())
	if got, _ := jsNumber(item["milkMl"]); got != 40 {
		t.Fatalf("created item milkMl = %v, want 40", item["milkMl"])
	}
}

// TestDeleteHistory_RemovesFinishedKeepsActive: DELETE /api/orders/history
// removes every done/declined order but keeps pending/accepted ones.
func TestDeleteHistory_RemovesFinishedKeepsActive(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)

	done := placeTestOrder(t, mux, nil)
	doneID, _ := done["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+doneID+"/accept", nil)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+doneID+"/complete", nil)

	declined := placeTestOrder(t, mux, nil)
	declinedID, _ := declined["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+declinedID+"/decline", mustMarshal(t, map[string]any{"reason": "gone"}))

	pending := placeTestOrder(t, mux, nil)
	pendingID, _ := pending["id"].(string)

	accepted := placeTestOrder(t, mux, nil)
	acceptedID, _ := accepted["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+acceptedID+"/accept", nil)

	rec := doJSON(t, mux, http.MethodDelete, "/api/orders/history", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete history status = %d; body=%s", rec.Code, rec.Body.String())
	}

	all, err := repo.FindAll()
	if err != nil {
		t.Fatalf("FindAll: %v", err)
	}
	remaining := map[string]bool{}
	for _, o := range all {
		id, _ := o["id"].(string)
		remaining[id] = true
	}
	if remaining[doneID] || remaining[declinedID] {
		t.Fatalf("finished orders still present after delete-history: %v", remaining)
	}
	if !remaining[pendingID] || !remaining[acceptedID] {
		t.Fatalf("active orders were wrongly deleted: %v", remaining)
	}
}
