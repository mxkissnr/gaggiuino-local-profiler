package orders

import (
	"database/sql"
	"net/http"
	"testing"
)

// TestOrdersDisabled_404 verifies the isOrdersEnabled gate: every
// /api/orders* route 404s when the feature is off, matching
// routes/orders.js's router.use('/api/orders', ...) guard.
func TestOrdersDisabled_404(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	t.Setenv("GLP_ENABLE_ORDERS", "false")
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/orders", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d; want 404; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "orders feature not enabled" {
		t.Errorf("error = %v", body["error"])
	}
}

// ── Menu ─────────────────────────────────────────────────────────────────

func TestMenu_DefaultSeed(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/orders/menu", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 6 {
		t.Fatalf("expected 6 default menu items, got %d", len(arr))
	}
	if arr[0]["name"] != "Espresso" {
		t.Errorf("first item name = %v", arr[0]["name"])
	}
}

func TestMenu_CreateUpdateDelete(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/menu", mustMarshal(t, map[string]any{
		"name": "Flat White Deluxe", "variants": []string{"oat", "whole"},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	item := decodeBody(t, rec.Body.Bytes())
	id, _ := item["id"].(string)
	if id == "" {
		t.Fatalf("expected id in created item: %+v", item)
	}
	if item["emoji"] != "☕" {
		t.Errorf("expected default emoji, got %v", item["emoji"])
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/orders/menu/"+id, mustMarshal(t, map[string]any{"trending": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["trending"] != true {
		t.Errorf("trending = %v", updated["trending"])
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/orders/menu/nonexistent", mustMarshal(t, map[string]any{"trending": true}))
	if rec.Code != http.StatusNotFound {
		t.Errorf("update nonexistent status = %d", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/orders/menu/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/orders/menu/"+id, nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("delete-again status = %d; want 404", rec.Code)
	}
}

func TestMenu_CreateRequiresName(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/menu", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400", rec.Code)
	}
}

// TestMenu_CreateRequiresName_EmptyBody guards against a Go-migration
// regression (#901, the same class of bug fixed for POST
// /api/maintenance/{task}/done): a genuinely empty request body (no bytes
// at all, distinct from `mustMarshal(t, map[string]any{})`'s literal `{}`
// above) must still 400 with "name required" for an endpoint with a
// required field -- httputil.DecodeJSONBody's io.EOF tolerance must not
// let the required-field check get skipped just because there was nothing
// to parse.
func TestMenu_CreateRequiresName_EmptyBody(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/menu", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400 for a bodyless create; body=%s", rec.Code, rec.Body.String())
	}
}

// TestMenu_Update_NoBodyIsNotAnError guards the flip side: PUT
// /api/orders/menu/{id} is a partial-update merge with no required fields,
// so a genuinely empty body must tolerate as {} (a no-op update) rather
// than 400ing on it.
func TestMenu_Update_NoBodyIsNotAnError(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/menu", mustMarshal(t, map[string]any{"name": "Flat White"}))
	item := decodeBody(t, rec.Body.Bytes())
	id, _ := item["id"].(string)
	if id == "" {
		t.Fatalf("expected id in created item: %+v", item)
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/orders/menu/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200 for a bodyless update; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["name"] != "Flat White" {
		t.Fatalf("unexpected item after bodyless update: %+v", updated)
	}
}

// ── Settings ─────────────────────────────────────────────────────────────

func TestSettings_GetPost(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders/settings", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d", rec.Code)
	}
	settings := decodeBody(t, rec.Body.Bytes())
	if settings["enabled"] != true {
		t.Errorf("default enabled = %v", settings["enabled"])
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/orders/settings", mustMarshal(t, map[string]any{
		"enabled": false, "broadcastRecipients": []string{"notify.phone", "bogus"},
		"baristaNotifyService": "notify.barista",
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("post status = %d; body=%s", rec.Code, rec.Body.String())
	}
	saved := decodeBody(t, rec.Body.Bytes())
	if saved["enabled"] != false {
		t.Errorf("enabled after post = %v", saved["enabled"])
	}
	recipients, _ := saved["broadcastRecipients"].([]any)
	if len(recipients) != 1 || recipients[0] != "notify.phone" {
		t.Errorf("broadcastRecipients = %+v (bogus non-notify.* value should be dropped)", recipients)
	}
	if saved["baristaNotifyService"] != "notify.barista" {
		t.Errorf("baristaNotifyService = %v", saved["baristaNotifyService"])
	}
}

func TestSettings_PostRequiresEnabledBoolean(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/settings", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400", rec.Code)
	}
}

// ── Place / accept / complete / decline lifecycle ───────────────────────

func placeTestOrder(t *testing.T, mux *http.ServeMux, extra map[string]any) map[string]any {
	t.Helper()
	body := map[string]any{"item": "Espresso", "customer": "Max"}
	for k, v := range extra {
		body[k] = v
	}
	rec := doJSON(t, mux, http.MethodPost, "/api/orders", mustMarshal(t, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("place order status = %d; body=%s", rec.Code, rec.Body.String())
	}
	return decodeBody(t, rec.Body.Bytes())
}

func TestPlaceOrder_HappyPath_HasID(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	order := placeTestOrder(t, mux, nil)
	if id, _ := order["id"].(string); id == "" {
		t.Fatalf("expected order.id in response: %+v", order)
	}
	if order["status"] != "pending" {
		t.Errorf("status = %v", order["status"])
	}
	if order["customer"] != "Max" {
		t.Errorf("customer = %v", order["customer"])
	}
}

func TestPlaceOrder_UnknownItem(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders", mustMarshal(t, map[string]any{
		"item": "Nonexistent Drink", "customer": "Max",
	}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPlaceOrder_MissingCustomer(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders", mustMarshal(t, map[string]any{"item": "Espresso"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400", rec.Code)
	}
}

func TestPlaceOrder_DisabledSettings503(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doJSON(t, mux, http.MethodPost, "/api/orders/settings", mustMarshal(t, map[string]any{"enabled": false}))
	rec := doJSON(t, mux, http.MethodPost, "/api/orders", mustMarshal(t, map[string]any{"item": "Espresso", "customer": "Max"}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d; want 503; body=%s", rec.Code, rec.Body.String())
	}
}

// HAUserID header precedence over the body field (#547) — the same
// precedence GET /api/orders/mine's query-param fallback documents, and
// exactly what glp-integration's orders_api.py proxy depends on: it always
// injects X-GLP-HA-User-ID from the authenticated HA session, and that
// must win over anything a compromised/buggy client puts in the body.
func TestPlaceOrder_HAUserIDHeaderPrecedence(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	r := httpNewJSONRequest(t, http.MethodPost, "/api/orders", mustMarshal(t, map[string]any{
		"item": "Espresso", "customer": "Max", "haUserId": "body-user",
	}))
	r.Header.Set("X-GLP-HA-User-ID", "header-user")
	rec := httptestRecord(mux, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	order := decodeBody(t, rec.Body.Bytes())
	if order["haUserId"] != "header-user" {
		t.Errorf("haUserId = %v; want header-user (header must win over body)", order["haUserId"])
	}
}

func TestOrderLifecycle_AcceptCompleteDecline(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	order := placeTestOrder(t, mux, nil)
	id, _ := order["id"].(string)

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", mustMarshal(t, map[string]any{"eta": 7}))
	if rec.Code != http.StatusOK {
		t.Fatalf("accept status = %d; body=%s", rec.Code, rec.Body.String())
	}
	accepted := decodeBody(t, rec.Body.Bytes())
	if accepted["status"] != "accepted" {
		t.Errorf("status = %v", accepted["status"])
	}
	if eta, ok := accepted["eta"].(float64); !ok || eta != 7 {
		t.Errorf("eta = %v", accepted["eta"])
	}

	// Accepting again (not pending anymore) must 400.
	rec = doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("re-accept status = %d; want 400", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/complete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("complete status = %d; body=%s", rec.Code, rec.Body.String())
	}
	completed := decodeBody(t, rec.Body.Bytes())
	if completed["status"] != "done" {
		t.Errorf("status = %v", completed["status"])
	}

	// A done order can be deleted from history.
	rec = doJSON(t, mux, http.MethodDelete, "/api/orders/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// TestAcceptOrder_ExplicitEtaZeroDefaultsTo5 (#901 code review): mirrors
// JS's `parseInt(rawEta) || 5` — 0 is falsy in JS, so an explicit `eta: 0`
// must default to 5 like an absent/unparseable eta does, not clamp to 1.
func TestAcceptOrder_ExplicitEtaZeroDefaultsTo5(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	order := placeTestOrder(t, mux, nil)
	id, _ := order["id"].(string)

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", mustMarshal(t, map[string]any{"eta": 0}))
	if rec.Code != http.StatusOK {
		t.Fatalf("accept status = %d; body=%s", rec.Code, rec.Body.String())
	}
	accepted := decodeBody(t, rec.Body.Bytes())
	if eta, ok := accepted["eta"].(float64); !ok || eta != 5 {
		t.Errorf("eta = %v; want 5 (eta:0 must default, not clamp to 1)", accepted["eta"])
	}
}

// TestAcceptOrder_OnlyTouchesItsOwnRow (#901 code review): AcceptOrder must
// write only the one order row it mutates, not the whole active-queue table
// (the old FindActive()+SaveAll() shape re-marshaled and rewrote every
// active order via INSERT OR REPLACE on every single accept/complete/
// decline). `orders.id` is a TEXT PRIMARY KEY, not a rowid alias, so
// SQLite's own implicit rowid is a reliable "was this exact row ever
// rewritten" witness: INSERT OR REPLACE on a primary-key conflict always
// deletes-then-reinserts that row, which changes its rowid — a bystander
// row's rowid staying exactly the same before/after proves it was never
// part of the write, which byte-comparing its `data` content alone could
// not (encoding/json's deterministic key sorting would make an unrelated
// row's re-marshaled bytes come back identical either way).
func TestAcceptOrder_OnlyTouchesItsOwnRow(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	target := placeTestOrder(t, mux, nil)
	targetID, _ := target["id"].(string)
	var bystanderIDs []string
	for i := 0; i < 3; i++ {
		o := placeTestOrder(t, mux, nil)
		id, _ := o["id"].(string)
		bystanderIDs = append(bystanderIDs, id)
	}

	before := make(map[string]int64, len(bystanderIDs))
	for _, id := range bystanderIDs {
		before[id] = orderRowID(t, sqlDB, id)
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+targetID+"/accept", mustMarshal(t, map[string]any{"eta": 9}))
	if rec.Code != http.StatusOK {
		t.Fatalf("accept status = %d; body=%s", rec.Code, rec.Body.String())
	}

	for _, id := range bystanderIDs {
		after := orderRowID(t, sqlDB, id)
		if after != before[id] {
			t.Errorf("bystander order %s's rowid changed (%d -> %d) after accepting a different order — it was rewritten", id, before[id], after)
		}
	}
}

func orderRowID(t *testing.T, sqlDB *sql.DB, id string) int64 {
	t.Helper()
	var rowid int64
	if err := sqlDB.QueryRow(`SELECT rowid FROM orders WHERE id = ?`, id).Scan(&rowid); err != nil {
		t.Fatalf("reading rowid for order %s: %v", id, err)
	}
	return rowid
}

func TestOrderLifecycle_Decline(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	order := placeTestOrder(t, mux, nil)
	id, _ := order["id"].(string)

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/decline", mustMarshal(t, map[string]any{"reason": "out of beans"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("decline status = %d; body=%s", rec.Code, rec.Body.String())
	}
	declined := decodeBody(t, rec.Body.Bytes())
	if declined["status"] != "declined" {
		t.Errorf("status = %v", declined["status"])
	}
	if declined["declineReason"] != "out of beans" {
		t.Errorf("declineReason = %v", declined["declineReason"])
	}

	// Deleting a non-completed (already declined is fine — declined IS
	// deletable) vs. testing 404 on unknown id:
	rec = doJSON(t, mux, http.MethodDelete, "/api/orders/does-not-exist", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("delete unknown status = %d; want 404", rec.Code)
	}
}

func TestOrderActions_NotFound(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	for _, action := range []string{"accept", "complete", "decline"} {
		rec := doJSON(t, mux, http.MethodPost, "/api/orders/nope/"+action, nil)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s status = %d; want 404", action, rec.Code)
		}
	}
}

// ── Mine (glp-integration proxy path) ───────────────────────────────────

func TestMine_HeaderPrecedenceOverQuery(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	placeTestOrder(t, mux, map[string]any{"haUserId": "query-user"})

	// Header identifies a DIFFERENT user than the query param — proxy
	// (glp-integration) always sets the header from the verified HA
	// session, so it must win.
	r := httpNewJSONRequest(t, http.MethodGet, "/api/orders/mine?haUserId=query-user", nil)
	r.Header.Set("X-GLP-HA-User-ID", "header-user")
	rec := httptestRecord(mux, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 0 {
		t.Errorf("expected no orders for header-user, got %d", len(arr))
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/orders/mine?haUserId=query-user", nil)
	arr = decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 {
		t.Fatalf("expected 1 order for query-user fallback, got %d", len(arr))
	}
}

func TestMine_RequiresHAUserID(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/orders/mine", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400", rec.Code)
	}
}

// ── The exact paths glp-integration's orders_api.py proxy allowlists ────
// (see the dispatch task's binding-contract note): /api/orders,
// /api/orders/{menu,settings,queue-eta,active-beans,mine}, and
// /api/orders/{id}/{accept,complete,decline}. Every one of these must
// answer 200 for a well-formed request when the feature is enabled.
func TestProxiedPaths_Answer200(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	order := placeTestOrder(t, mux, nil)
	id, _ := order["id"].(string)

	getPaths := []string{
		"/api/orders", "/api/orders/menu", "/api/orders/settings",
		"/api/orders/queue-eta", "/api/orders/active-beans",
		"/api/orders/mine?haUserId=whoever",
	}
	for _, p := range getPaths {
		rec := doJSON(t, mux, http.MethodGet, p, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s status = %d; body=%s", p, rec.Code, rec.Body.String())
		}
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", nil)
	if rec.Code != http.StatusOK {
		t.Errorf("POST accept status = %d; body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/complete", nil)
	if rec.Code != http.StatusOK {
		t.Errorf("POST complete status = %d; body=%s", rec.Code, rec.Body.String())
	}

	order2 := placeTestOrder(t, mux, nil)
	id2, _ := order2["id"].(string)
	rec = doJSON(t, mux, http.MethodPost, "/api/orders/"+id2+"/decline", nil)
	if rec.Code != http.StatusOK {
		t.Errorf("POST decline status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// ── Stats / history ──────────────────────────────────────────────────────

func TestStats_EmptyThenPopulated(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/orders/stats", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	stats := decodeBody(t, rec.Body.Bytes())
	if total, _ := stats["total"].(float64); total != 0 {
		t.Errorf("empty total = %v", stats["total"])
	}

	order := placeTestOrder(t, mux, nil)
	id, _ := order["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/accept", nil)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+id+"/complete", nil)

	rec = doJSON(t, mux, http.MethodGet, "/api/orders/stats", nil)
	stats = decodeBody(t, rec.Body.Bytes())
	if total, _ := stats["total"].(float64); total != 1 {
		t.Errorf("total after 1 completed order = %v", stats["total"])
	}
	mostPopular, _ := stats["mostPopular"].(map[string]any)
	if mostPopular == nil || mostPopular["item"] != "Espresso" {
		t.Errorf("mostPopular = %+v", stats["mostPopular"])
	}
}

func TestDeleteHistory_OnlyRemovesCompleted(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	pending := placeTestOrder(t, mux, nil)
	done := placeTestOrder(t, mux, nil)
	doneID, _ := done["id"].(string)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+doneID+"/accept", nil)
	doJSON(t, mux, http.MethodPost, "/api/orders/"+doneID+"/complete", nil)

	rec := doJSON(t, mux, http.MethodDelete, "/api/orders/history", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/orders", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 {
		t.Fatalf("expected 1 remaining (pending) order, got %d: %+v", len(arr), arr)
	}
	if arr[0]["id"] != pending["id"] {
		t.Errorf("remaining order = %+v; want the pending one", arr[0])
	}
}
