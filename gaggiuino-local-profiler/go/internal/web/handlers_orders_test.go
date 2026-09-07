package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// newTestOrdersServer opens a throwaway on-disk SQLite DB (same pattern as
// newTestLibraryServer/newTestServer above) and wires it into a fresh
// web.OrdersHandlers routed through a real *http.ServeMux. Sets
// GLP_ENABLE_ORDERS=true (mirroring internal/orders' own
// helpers_test.go's newTestHandlers) so every test below runs with the
// orders feature on unless it explicitly overrides that.
func newTestOrdersServer(t *testing.T) (*http.ServeMux, *orders.Repository, *library.Repository) {
	t.Helper()
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	ordersRepo := orders.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv() // no SUPERVISOR_TOKEN/GLP_HA_URL in test env -> disabled, no real HTTP calls

	h := NewOrdersHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux, ordersRepo, libRepo
}

func seedOrder(t *testing.T, repo *orders.Repository, id, item, customer, status string, createdAt int64) {
	t.Helper()
	o := orders.Order{
		"id": id, "item": item, "customer": customer, "status": status,
		"createdAt": createdAt, "machineId": int64(1),
	}
	if status == "accepted" {
		o["eta"] = int64(7)
		o["acceptedAt"] = createdAt
	}
	if err := repo.Save(o); err != nil {
		t.Fatalf("seeding order %s: %v", id, err)
	}
}

func doFormPost(t *testing.T, mux *http.ServeMux, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// doFormPut is doFormPost's PUT counterpart — the Edit UI's save action
// (handlers_library.go's updateBeanAction et al., handlers_machines.go's
// updateAction) uses hx-put, not hx-post, since it's a partial update of an
// existing entity rather than a create.
func doFormPut(t *testing.T, mux *http.ServeMux, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// ── Barista queue ──────────────────────────────────────────────────────

func TestOrdersPage_RendersQueue(t *testing.T) {
	mux, repo, _ := newTestOrdersServer(t)
	seedOrder(t, repo, "ord_1", "Espresso", "Alice", "pending", 1_700_000_000_000)
	seedOrder(t, repo, "ord_2", "Latte Macchiato", "Bob", "accepted", 1_700_000_001_000)

	rec := doRequest(t, mux, "GET", "/orders")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /orders: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"Espresso", "Alice", `hx-post="orders/ord_1/accept"`, `hx-post="orders/ord_1/decline"`,
		"Latte Macchiato", "Bob", `hx-post="orders/ord_2/complete"`, `hx-post="orders/ord_2/decline"`,
		"ready in ~7 min",
		`sse-connect="api/events"`, `sse-swap="orders-update"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /orders body missing %q\nbody:\n%s", want, body)
		}
	}
	if strings.Contains(body, `hx-post="orders/ord_1/complete"`) {
		t.Errorf("GET /orders: pending order should not offer Complete\nbody:\n%s", body)
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestOrdersPage_Empty(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	rec := doRequest(t, mux, "GET", "/orders")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /orders: status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "No pending orders.") || !strings.Contains(body, "No accepted orders.") {
		t.Errorf("GET /orders body missing empty-state messages:\n%s", body)
	}
}

func TestOrdersPage_FeatureDisabled(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	t.Setenv("GLP_ENABLE_ORDERS", "false")
	rec := doRequest(t, mux, "GET", "/orders")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /orders: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Orders feature disabled.") {
		t.Errorf("GET /orders body missing disabled notice:\n%s", rec.Body.String())
	}
}

// TestOrderActions_RoundTrip drives accept/complete/decline end to end: an
// accept moves the order from pending to accepted, a complete removes it
// from the queue entirely, and a decline on a separate pending order also
// removes it — the same orders.Service.AcceptOrder/CompleteOrder/DeclineOrder
// internal/orders' own REST handlers call.
func TestOrderActions_RoundTrip(t *testing.T) {
	mux, repo, _ := newTestOrdersServer(t)
	seedOrder(t, repo, "ord_1", "Espresso", "Alice", "pending", 1_700_000_000_000)
	seedOrder(t, repo, "ord_2", "Cappuccino", "Carol", "pending", 1_700_000_002_000)

	acceptRec := doRequest(t, mux, "POST", "/orders/ord_1/accept")
	if acceptRec.Code != http.StatusOK {
		t.Fatalf("POST /orders/ord_1/accept: status = %d, body = %s", acceptRec.Code, acceptRec.Body.String())
	}
	body := acceptRec.Body.String()
	if !strings.Contains(body, `hx-post="orders/ord_1/complete"`) {
		t.Errorf("POST /orders/ord_1/accept: response should show ord_1 as accepted (Complete action)\nbody:\n%s", body)
	}
	if strings.Contains(body, `hx-post="orders/ord_1/accept"`) {
		t.Errorf("POST /orders/ord_1/accept: response should no longer offer Accept for ord_1\nbody:\n%s", body)
	}

	order, err := repo.FindByID("ord_1")
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if status, _ := order["status"].(string); status != "accepted" {
		t.Errorf("ord_1 status = %q, want accepted", status)
	}
	if eta, ok := order["eta"].(float64); !ok || eta != 5 {
		t.Errorf("ord_1 eta = %v, want 5 (default eta, no picker in this phase)", order["eta"])
	}

	completeRec := doRequest(t, mux, "POST", "/orders/ord_1/complete")
	if completeRec.Code != http.StatusOK {
		t.Fatalf("POST /orders/ord_1/complete: status = %d, body = %s", completeRec.Code, completeRec.Body.String())
	}
	if strings.Contains(completeRec.Body.String(), "ord_1") {
		t.Errorf("POST /orders/ord_1/complete: response should no longer list ord_1 (queue is pending+accepted only)\nbody:\n%s", completeRec.Body.String())
	}

	declineRec := doRequest(t, mux, "POST", "/orders/ord_2/decline")
	if declineRec.Code != http.StatusOK {
		t.Fatalf("POST /orders/ord_2/decline: status = %d, body = %s", declineRec.Code, declineRec.Body.String())
	}
	if strings.Contains(declineRec.Body.String(), "ord_2") {
		t.Errorf("POST /orders/ord_2/decline: response should no longer list ord_2\nbody:\n%s", declineRec.Body.String())
	}
	declined, err := repo.FindByID("ord_2")
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if status, _ := declined["status"].(string); status != "declined" {
		t.Errorf("ord_2 status = %q, want declined", status)
	}
}

// TestOrderActions_PublishSSEUpdate pins the live-update wiring
// templates/orders.templ's own doc comment describes: every queue-changing
// action (here, accept) must publish an sse.EventOrdersUpdate event onto
// the shared *sse.Hub carrying the freshly-rendered queue fragment as raw
// HTML (sse.HTML, not JSON) — the actual fix for the two blockers
// go/README.md's Status section used to document against using SSE here.
func TestOrderActions_PublishSSEUpdate(t *testing.T) {
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	ordersRepo := orders.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()
	seedOrder(t, ordersRepo, "ord_1", "Espresso", "Alice", "pending", 1_700_000_000_000)

	hub := sse.NewHub()
	h := NewOrdersHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient, hub)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	sub, unsubscribe := hub.Subscribe()
	defer unsubscribe()

	rec := doRequest(t, mux, "POST", "/orders/ord_1/accept")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /orders/ord_1/accept: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	select {
	case ev := <-sub:
		if ev.Type != sse.EventOrdersUpdate {
			t.Errorf("event type = %q, want %q", ev.Type, sse.EventOrdersUpdate)
		}
		html, ok := ev.Data.(sse.HTML)
		if !ok {
			t.Fatalf("event Data type = %T, want sse.HTML", ev.Data)
		}
		if !strings.Contains(string(html), `hx-post="orders/ord_1/complete"`) {
			t.Errorf("published fragment doesn't reflect ord_1 as accepted:\n%s", html)
		}
	case <-time.After(time.Second):
		t.Fatal("no orders-update event published within 1s of accepting an order")
	}
}

// TestRESTAPIOrderAction_AlsoPublishesSSEUpdate pins the #901 code review
// fix (CONFIRMED finding #2): internal/orders.Handlers (the REST API) and
// web.OrdersHandlers each own an independent *orders.Service — before this
// fix, only the web instance's OnQueueChanged was wired to the SSE hub, so
// mutating an order through the REST API alone (glp-integration, or any
// other external client) never published a live orders-update event
// despite go/README.md documenting "regardless of caller — the REST API
// included". This wires both Service instances onto the same hub the exact
// way cmd/server/main.go now does (orders.Handlers.Service().OnQueueChanged
// = webOrdersHandlers.PublishQueueUpdate) and drives the mutation through
// the REST mux, not the web one, to prove that path publishes too.
func TestRESTAPIOrderAction_AlsoPublishesSSEUpdate(t *testing.T) {
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	ordersRepo := orders.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()
	seedOrder(t, ordersRepo, "ord_1", "Espresso", "Alice", "pending", 1_700_000_000_000)

	restHandlers := orders.NewHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient)
	restMux := http.NewServeMux()
	restHandlers.RegisterRoutes(restMux)

	hub := sse.NewHub()
	webHandlers := NewOrdersHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient, hub)
	// The same wiring cmd/server/main.go does after constructing both
	// handlers — see this file's own doc comment.
	restHandlers.Service().OnQueueChanged = webHandlers.PublishQueueUpdate

	sub, unsubscribe := hub.Subscribe()
	defer unsubscribe()

	rec := doRequest(t, restMux, "POST", "/api/orders/ord_1/accept")
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/orders/ord_1/accept: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	select {
	case ev := <-sub:
		if ev.Type != sse.EventOrdersUpdate {
			t.Errorf("event type = %q, want %q", ev.Type, sse.EventOrdersUpdate)
		}
	case <-time.After(time.Second):
		t.Fatal("no orders-update event published within 1s of accepting an order through the REST API")
	}
}

func TestAcceptAction_NotFound(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	rec := doRequest(t, mux, "POST", "/orders/nope/accept")
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /orders/nope/accept: status = %d, want 404, body = %s", rec.Code, rec.Body.String())
	}
}

func TestOrderActions_FeatureDisabled(t *testing.T) {
	mux, repo, _ := newTestOrdersServer(t)
	seedOrder(t, repo, "ord_1", "Espresso", "Alice", "pending", 1_700_000_000_000)
	t.Setenv("GLP_ENABLE_ORDERS", "false")

	for _, path := range []string{"/orders/ord_1/accept", "/orders/ord_1/complete", "/orders/ord_1/decline"} {
		rec := doRequest(t, mux, "POST", path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("POST %s with orders disabled: status = %d, want 404", path, rec.Code)
		}
	}
}

// capturedNotify is one notify.<service> call the fake HA server below
// recorded, keyed by its tag (SendNotify's 4th argument — internal/orders'
// Service.notifyOrderStatus always passes the order id).
type capturedNotify struct{ title, message string }

// newFakeHAServer starts an httptest.Server standing in for Home Assistant's
// REST API, recording every notify.<service> call's title/message by its
// "tag" (same pattern as internal/orders/broadcast_test.go's haSrv). Also
// sets the env vars ha.NewClientFromEnv() needs to actually target it.
func newFakeHAServer(t *testing.T) (getNotify func(tag string) (capturedNotify, bool)) {
	t.Helper()
	var mu sync.Mutex
	got := map[string]capturedNotify{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/services/notify/") {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			title, _ := body["title"].(string)
			message, _ := body["message"].(string)
			var tag string
			if data, ok := body["data"].(map[string]any); ok {
				tag, _ = data["tag"].(string)
			}
			mu.Lock()
			got[tag] = capturedNotify{title: title, message: message}
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", srv.URL)
	t.Setenv("GLP_HA_TOKEN", "test-token")

	return func(tag string) (capturedNotify, bool) {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			n, ok := got[tag]
			mu.Unlock()
			if ok {
				return n, true
			}
			time.Sleep(10 * time.Millisecond)
		}
		return capturedNotify{}, false
	}
}

// TestOrderActions_SendSameCustomerNotificationAsRESTAPI proves the #901
// code-review finding stays fixed: internal/web's OrdersHandlers (the new
// /orders queue's htmx accept/complete/decline actions) must trigger the
// exact same customer HA notification internal/orders' REST API
// (POST /api/orders/{id}/accept|complete|decline) does, since both now call
// the same orders.Service.AcceptOrder/CompleteOrder/DeclineOrder methods —
// see internal/orders/service.go's notifyOrderStatus. Before that fix, this
// package built its own *orders.Service with no *ha.Client of its own, so
// the web queue's actions never notified customers at all.
func TestOrderActions_SendSameCustomerNotificationAsRESTAPI(t *testing.T) {
	getNotify := newFakeHAServer(t)
	t.Setenv("GLP_ENABLE_ORDERS", "true")

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	ordersRepo := orders.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()

	restHandlers := orders.NewHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient)
	restMux := http.NewServeMux()
	restHandlers.RegisterRoutes(restMux)

	webHandlers := NewOrdersHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient, nil)
	webMux := http.NewServeMux()
	webHandlers.RegisterRoutes(webMux)

	// Both orders carry a directly-set notifyService (rather than relying on
	// the haUserId->notify-mapping lookup) so notifyOrderStatus has an HA
	// service to actually call — see seedOrder's callers elsewhere in this
	// file, which don't set it and so never provoke a real HA call.
	newOrder := func(id string) orders.Order {
		return orders.Order{
			"id": id, "item": "Espresso", "customer": "Alice", "status": "pending",
			"createdAt": int64(1_700_000_000_000), "machineId": int64(1),
			"notifyService": "notify.mobile_app_test",
		}
	}
	for _, id := range []string{"ord_rest_accept", "ord_web_accept", "ord_rest_complete", "ord_web_complete", "ord_rest_decline", "ord_web_decline"} {
		if err := ordersRepo.Save(newOrder(id)); err != nil {
			t.Fatalf("seeding %s: %v", id, err)
		}
	}

	// Accept
	if rec := doRestRequest(restMux, "/api/orders/ord_rest_accept/accept"); rec.Code != http.StatusOK {
		t.Fatalf("REST accept: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := doRequest(t, webMux, "POST", "/orders/ord_web_accept/accept"); rec.Code != http.StatusOK {
		t.Fatalf("web accept: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	restAccept, ok := getNotify("ord_rest_accept")
	if !ok {
		t.Fatal("REST accept: expected a customer HA notification, got none")
	}
	webAccept, ok := getNotify("ord_web_accept")
	if !ok {
		t.Fatal("web accept: expected a customer HA notification, got none — the new /orders queue action must notify the customer exactly like the REST API does (#901)")
	}
	if restAccept != webAccept {
		t.Errorf("accept notification mismatch: REST = %+v, web = %+v, want identical", restAccept, webAccept)
	}

	// Complete
	if rec := doRestRequest(restMux, "/api/orders/ord_rest_complete/complete"); rec.Code != http.StatusOK {
		t.Fatalf("REST complete: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := doRequest(t, webMux, "POST", "/orders/ord_web_complete/complete"); rec.Code != http.StatusOK {
		t.Fatalf("web complete: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	restComplete, ok := getNotify("ord_rest_complete")
	if !ok {
		t.Fatal("REST complete: expected a customer HA notification, got none")
	}
	webComplete, ok := getNotify("ord_web_complete")
	if !ok {
		t.Fatal("web complete: expected a customer HA notification, got none — regression against #901's fix")
	}
	if restComplete != webComplete {
		t.Errorf("complete notification mismatch: REST = %+v, web = %+v, want identical", restComplete, webComplete)
	}

	// Decline
	if rec := doRestRequest(restMux, "/api/orders/ord_rest_decline/decline"); rec.Code != http.StatusOK {
		t.Fatalf("REST decline: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := doRequest(t, webMux, "POST", "/orders/ord_web_decline/decline"); rec.Code != http.StatusOK {
		t.Fatalf("web decline: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	restDecline, ok := getNotify("ord_rest_decline")
	if !ok {
		t.Fatal("REST decline: expected a customer HA notification, got none")
	}
	webDecline, ok := getNotify("ord_web_decline")
	if !ok {
		t.Fatal("web decline: expected a customer HA notification, got none — regression against #901's fix")
	}
	if restDecline != webDecline {
		t.Errorf("decline notification mismatch: REST = %+v, web = %+v, want identical", restDecline, webDecline)
	}
}

// doRestRequest POSTs a nil-body request against restMux — internal/orders'
// own REST accept/complete/decline handlers all accept an absent JSON body
// (decodeOptionalJSONBody), the same way POST /orders/{id}/accept etc.
// (this package's doRequest) do.
func doRestRequest(restMux *http.ServeMux, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, nil)
	rec := httptest.NewRecorder()
	restMux.ServeHTTP(rec, req)
	return rec
}

// ── Customer menu ──────────────────────────────────────────────────────

func TestMenuPage_RendersMenuAndBeans(t *testing.T) {
	mux, _, libRepo := newTestOrdersServer(t)
	if err := libRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{
			{"id": int64(1), "name": "Ethiopia Yirgacheffe", "stock_g": 250.0},
		},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	rec := doRequest(t, mux, "GET", "/menu")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /menu: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"Espresso", // default menu seed item
		"Ethiopia Yirgacheffe",
		`hx-post="menu/order"`,
		`name="customer"`, `name="item"`, `name="beanId"`, `name="note"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("GET /menu body missing %q\nbody:\n%s", want, body)
		}
	}
	assertNoRootAbsolutePaths(t, body)
}

func TestMenuPage_NoActiveBeans_HidesBeanSelect(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	rec := doRequest(t, mux, "GET", "/menu")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /menu: status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), `name="beanId"`) {
		t.Errorf("GET /menu: no active beans, should not render a beanId select\nbody:\n%s", rec.Body.String())
	}
}

func TestMenuPage_FeatureDisabled(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	t.Setenv("GLP_ENABLE_ORDERS", "false")
	rec := doRequest(t, mux, "GET", "/menu")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /menu: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Orders feature disabled.") {
		t.Errorf("GET /menu body missing disabled notice:\n%s", rec.Body.String())
	}
}

func TestMenuPage_ShopClosed(t *testing.T) {
	mux, repo, _ := newTestOrdersServer(t)
	if err := repo.SaveSettings(orders.Settings{"enabled": false}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	rec := doRequest(t, mux, "GET", "/menu")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /menu: status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "Not accepting orders right now.") {
		t.Errorf("GET /menu body missing shop-closed notice:\n%s", body)
	}
	if strings.Contains(body, `hx-post="menu/order"`) {
		t.Errorf("GET /menu: shop closed, should not render the order form\nbody:\n%s", body)
	}
}

// TestPlaceOrderAction_RoundTrip drives POST /menu/order end to end: a
// known menu item + customer name places a pending order via
// orders.Service.PlaceOrder, visible afterward in the barista queue.
func TestPlaceOrderAction_RoundTrip(t *testing.T) {
	mux, repo, _ := newTestOrdersServer(t)

	rec := doFormPost(t, mux, "/menu/order", url.Values{
		"customer": {"Dana"}, "item": {"Espresso"}, "note": {"extra hot"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /menu/order: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Espresso") || !strings.Contains(rec.Body.String(), "Dana") {
		t.Errorf("POST /menu/order body = %q, want it to confirm item+customer", rec.Body.String())
	}

	active, err := repo.FindActive()
	if err != nil {
		t.Fatalf("FindActive: %v", err)
	}
	if len(active) != 1 {
		t.Fatalf("FindActive() = %d orders, want 1", len(active))
	}
	if item, _ := active[0]["item"].(string); item != "Espresso" {
		t.Errorf("placed order item = %q, want Espresso", item)
	}
	if customer, _ := active[0]["customer"].(string); customer != "Dana" {
		t.Errorf("placed order customer = %q, want Dana", customer)
	}
	if note, _ := active[0]["note"].(string); note != "extra hot" {
		t.Errorf("placed order note = %q, want %q", note, "extra hot")
	}
	if status, _ := active[0]["status"].(string); status != "pending" {
		t.Errorf("placed order status = %q, want pending", status)
	}
}

func TestPlaceOrderAction_MissingFields(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	rec := doFormPost(t, mux, "/menu/order", url.Values{"item": {"Espresso"}}) // no customer
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /menu/order without a customer: status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

func TestPlaceOrderAction_UnknownItem(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	rec := doFormPost(t, mux, "/menu/order", url.Values{"customer": {"Dana"}, "item": {"Nonexistent Drink"}})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST /menu/order with an unknown item: status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

func TestPlaceOrderAction_ShopClosed(t *testing.T) {
	mux, repo, _ := newTestOrdersServer(t)
	if err := repo.SaveSettings(orders.Settings{"enabled": false}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	rec := doFormPost(t, mux, "/menu/order", url.Values{"customer": {"Dana"}, "item": {"Espresso"}})
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("POST /menu/order with the shop closed: status = %d, want 503, body = %s", rec.Code, rec.Body.String())
	}
}

func TestPlaceOrderAction_FeatureDisabled(t *testing.T) {
	mux, _, _ := newTestOrdersServer(t)
	t.Setenv("GLP_ENABLE_ORDERS", "false")
	rec := doFormPost(t, mux, "/menu/order", url.Values{"customer": {"Dana"}, "item": {"Espresso"}})
	if rec.Code != http.StatusNotFound {
		t.Errorf("POST /menu/order with orders disabled: status = %d, want 404, body = %s", rec.Code, rec.Body.String())
	}
}

// ── Auth ───────────────────────────────────────────────────────────────

// TestOrdersMenuPagesRequireAuthBehindRequireToken wires this package's
// Orders/Menu routes behind auth.RequireToken the same way cmd/server
// actually does (mirroring handlers_test.go's
// TestTrashRestore_RequireAuthBehindRequireToken and
// handlers_library_test.go's TestLibraryPagesRequireAuthBehindRequireToken)
// and confirms every GET page stays reachable without a token, while every
// write action this phase adds — accept/complete/decline and
// POST /menu/order — requires either genuine HA Ingress or a valid
// X-GLP-Token.
func TestOrdersMenuPagesRequireAuthBehindRequireToken(t *testing.T) {
	const testToken = "test-fixture-token-not-a-real-secret"
	t.Setenv("GLP_ENABLE_ORDERS", "true")

	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	ordersRepo := orders.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()
	seedOrder(t, ordersRepo, "ord_1", "Espresso", "Alice", "pending", 1_700_000_000_000)

	h := NewOrdersHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient, nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	handler := auth.RequireToken(testToken)(mux)

	doAuthed := func(method, path, token string, form url.Values) *httptest.ResponseRecorder {
		var req *http.Request
		if form != nil {
			req = httptest.NewRequest(method, path, strings.NewReader(form.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		req.RemoteAddr = "192.168.1.50:1234" // LAN, not Ingress/Supervisor
		if token != "" {
			req.Header.Set("X-GLP-Token", token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	for _, path := range []string{"/orders", "/orders/queue-fragment", "/menu"} {
		if rec := doAuthed("GET", path, "", nil); rec.Code != http.StatusOK {
			t.Errorf("GET %s without a token: status = %d, want 200, body = %s", path, rec.Code, rec.Body.String())
		}
	}

	for _, path := range []string{"/orders/ord_1/accept", "/orders/ord_1/complete", "/orders/ord_1/decline"} {
		if rec := doAuthed("POST", path, "", nil); rec.Code != http.StatusUnauthorized {
			t.Errorf("POST %s without a token: status = %d, want 401", path, rec.Code)
		}
	}
	if rec := doAuthed("POST", "/menu/order", "", url.Values{"customer": {"Dana"}, "item": {"Espresso"}}); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /menu/order without a token: status = %d, want 401", rec.Code)
	}

	if rec := doAuthed("POST", "/orders/ord_1/accept", testToken, nil); rec.Code != http.StatusOK {
		t.Errorf("POST /orders/ord_1/accept with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if rec := doAuthed("POST", "/menu/order", testToken, url.Values{"customer": {"Dana"}, "item": {"Espresso"}}); rec.Code != http.StatusOK {
		t.Errorf("POST /menu/order with a valid token: status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
}
