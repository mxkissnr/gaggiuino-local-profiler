package web

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// This file is Phase 2d's (#901) Orders-domain counterpart to
// handlers_machines.go: the barista queue (GET /orders + its three htmx
// write actions) and the customer ordering form (GET /menu + its one write
// action) — see go/README.md's Status section, this package's doc.go for the
// auth model every route below relies on unchanged, and templates/orders.templ's
// own doc comment for why this phase polls (`hx-trigger="every 10s"`)
// instead of using the htmx SSE extension.
//
// Every handler here calls internal/orders.Service/Repository directly — the
// same dependencies internal/orders' own REST handlers.go calls — never
// internal/orders' JSON handlers themselves, mirroring every earlier
// Phase-2 page's convention (see internal/web/doc.go). This package builds
// its own *orders.Service instance around the same repo + HA-client
// dependencies cmd/server already shares with internal/orders' REST
// Handlers, rather than reaching into that struct's unexported service
// field — the same convention web.NewHandlers (shots) and
// web.NewMachinesHandlers already established. Sharing haClient (not just
// the repos) matters here specifically: Service.AcceptOrder/CompleteOrder/
// DeclineOrder send the customer's HA status-change notification themselves
// (#901 code review — it used to be a private method on internal/orders'
// REST *Handlers that this package's own *orders.Service instance had no
// way to reach, so the web queue silently never notified customers).
type OrdersHandlers struct {
	repo      *orders.Repository
	service   *orders.Service
	libRepo   *library.Repository
	shotsRepo *shots.Repository
	rl        *ratelimit.KeyedLimiter
	hub       *sse.Hub
}

// NewOrdersHandlers builds OrdersHandlers around the same *orders.Repository/
// *shots.Repository/*library.Repository/*machines.Registry/*ha.Client
// cmd/server already constructs once and shares with internal/orders' own
// REST handlers, plus the same *sse.Hub cmd/server wires into
// internal/sse.Handler for GET /api/events. rl is this page's own rate
// limiter for POST /menu/order — separate from internal/orders.Handlers'
// own "orders:"+ip-keyed one (internal/orders/handlers.go's placeOrder),
// since this page bypasses that REST handler entirely and calls
// Service.PlaceOrder directly; without its own limiter this form would have
// no rate protection at all, unlike every other path to placing an order.
// Wires h.PublishQueueUpdate onto this instance's own Service.OnQueueChanged
// (#901) — see templates/orders.templ's own doc comment for the live-update
// mechanism this closes. PublishQueueUpdate is exported (#901 code review,
// CONFIRMED finding #2) so cmd/server's main.go can ALSO wire it onto
// internal/orders.Handlers' own separate *Service instance (that package's
// REST API) — otherwise an order mutated through the REST API alone never
// published a live update, despite go/README.md documenting "regardless of
// caller — the REST API included". See orders.Handlers.Service's own doc
// comment for why this stays two Service instances wired to the same
// publish function, not one shared instance.
func NewOrdersHandlers(repo *orders.Repository, shotsRepo *shots.Repository, libRepo *library.Repository, registry *machines.Registry, haClient *ha.Client, hub *sse.Hub) *OrdersHandlers {
	h := &OrdersHandlers{
		repo:      repo,
		service:   orders.NewService(repo, shotsRepo, libRepo, registry, haClient),
		libRepo:   libRepo,
		shotsRepo: shotsRepo,
		rl:        ratelimit.NewKeyed(),
		hub:       hub,
	}
	h.service.OnQueueChanged = h.PublishQueueUpdate
	return h
}

// PublishQueueUpdate renders the current barista queue and publishes it as
// an sse.EventOrdersUpdate event — orders.Service's OnQueueChanged callback,
// fired after every successful PlaceOrder/AcceptOrder/CompleteOrder/
// DeclineOrder on WHICHEVER *orders.Service instance it's wired to (this
// page's own, or — since main.go wires it onto both, see NewOrdersHandlers'
// own doc comment — internal/orders.Handlers' REST-API instance too).
// Exported so main.go can reach it for that second wiring. hub == nil (a
// caller that never wired one, e.g. a focused test building *OrdersHandlers
// some other way) is a silent no-op, not a panic — matches every other
// nil-safe optional dependency in this package (MachinesHandlers.poller's
// own doc comment gives the same reasoning). A render failure here is
// logged, not returned — this runs from inside Service's own call stack
// (AcceptOrder et al.), which has no HTTP response to fail; the order's own
// state change already succeeded by the time this callback fires, so a
// fragment-rendering error here must not undo it.
func (h *OrdersHandlers) PublishQueueUpdate() {
	if h.hub == nil {
		return
	}
	pending, accepted, err := h.queueRows()
	if err != nil {
		log.Printf("web: building orders-update SSE fragment: %v", err)
		return
	}
	var buf bytes.Buffer
	if err := templates.OrdersQueueFragment(pending, accepted).Render(context.Background(), &buf); err != nil {
		log.Printf("web: rendering orders-update SSE fragment: %v", err)
		return
	}
	h.hub.Publish(sse.Event{Type: sse.EventOrdersUpdate, Data: sse.HTML(buf.String())})
}

// RegisterRoutes registers this file's page and htmx-action routes onto
// mux — not prefixed with /api/, for the same GET/HEAD-auth-bypass reason
// handlers.go's RegisterRoutes documents.
func (h *OrdersHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /orders", h.ordersPage)
	mux.HandleFunc("GET /orders/queue-fragment", h.queueFragmentPage)
	mux.HandleFunc("POST /orders/{id}/accept", h.acceptAction)
	mux.HandleFunc("POST /orders/{id}/complete", h.completeAction)
	mux.HandleFunc("POST /orders/{id}/decline", h.declineAction)

	mux.HandleFunc("GET /menu", h.menuPage)
	mux.HandleFunc("POST /menu/order", h.placeOrderAction)
}

// ── Barista queue ──────────────────────────────────────────────────────

// queueRows builds every active order's templates.OrderRow, split into the
// two sections orders.templ renders — pending and accepted. Declined/done
// orders (still returned by FindActive within its 7-day TTL window, see
// internal/orders/repository.go's isActiveOrder) are deliberately excluded:
// this is a queue view, not the history/stats surface public-src/views/orders.js
// also renders, which this phase's dispatch brief scopes out.
func (h *OrdersHandlers) queueRows() (pending, accepted []templates.OrderRow, err error) {
	active, err := h.repo.FindActive()
	if err != nil {
		return nil, nil, err
	}
	for _, o := range active {
		row := toOrderRow(o)
		switch row.Status {
		case "pending":
			pending = append(pending, row)
		case "accepted":
			accepted = append(accepted, row)
		}
	}
	return pending, accepted, nil
}

// ordersPage ports GET /orders: the full page (see templates/orders.templ's
// own doc comment for why its live-update mechanism is polling, not SSE).
func (h *OrdersHandlers) ordersPage(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := templates.OrdersPage(false, nil, nil).Render(r.Context(), w); err != nil {
			log.Printf("web: rendering /orders (disabled): %v", err)
		}
		return
	}
	pending, accepted, err := h.queueRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.OrdersPage(true, pending, accepted).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /orders: %v", err)
	}
}

// queueFragmentPage answers GET /orders/queue-fragment — the page's own
// `hx-trigger="every 10s"` polling target, re-rendering the same queue
// section markup ordersPage embeds.
func (h *OrdersHandlers) queueFragmentPage(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		writeFragmentError(w, http.StatusNotFound, "Orders feature not enabled")
		return
	}
	h.renderQueueFragment(w, r, "/orders/queue-fragment")
}

// renderQueueFragment answers r with the current queue's OrdersQueueFragment
// — shared by the polling GET above and every write action below, all of
// which change queue membership (a pending order becomes accepted, an
// accepted or pending one leaves the queue) and so all answer with the whole
// queue, not a single row (see templates/orders.templ's OrdersQueueFragment
// doc comment). logCtx names the route in this handler's own log line on a
// render failure.
func (h *OrdersHandlers) renderQueueFragment(w http.ResponseWriter, r *http.Request, logCtx string) {
	pending, accepted, err := h.queueRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.OrdersQueueFragment(pending, accepted).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering %s: %v", logCtx, err)
	}
}

// acceptAction ports the htmx `hx-post="/orders/{id}/accept"` interaction:
// orders.Service.AcceptOrder with no eta (the same "absent -> defaults to 5
// min" fallback POST /api/orders/{id}/accept's own empty-body case already
// exercises, see internal/orders/service.go's AcceptOrder) — this phase's
// queue view deliberately has no eta picker (see NewOrdersHandlers' doc
// comment on scope).
func (h *OrdersHandlers) acceptAction(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		writeFragmentError(w, http.StatusNotFound, "Orders feature not enabled")
		return
	}
	if _, err := h.service.AcceptOrder(r.PathValue("id"), nil); err != nil {
		writeOrdersActionError(w, err)
		return
	}
	h.renderQueueFragment(w, r, "/orders/{id}/accept")
}

// completeAction ports the htmx `hx-post="/orders/{id}/complete"` interaction.
func (h *OrdersHandlers) completeAction(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		writeFragmentError(w, http.StatusNotFound, "Orders feature not enabled")
		return
	}
	if _, err := h.service.CompleteOrder(r.PathValue("id")); err != nil {
		writeOrdersActionError(w, err)
		return
	}
	h.renderQueueFragment(w, r, "/orders/{id}/complete")
}

// declineAction ports the htmx `hx-post="/orders/{id}/decline"` interaction
// with no reason — same scope cut as acceptAction's missing eta picker (no
// decline-reason input in this phase's queue view).
func (h *OrdersHandlers) declineAction(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		writeFragmentError(w, http.StatusNotFound, "Orders feature not enabled")
		return
	}
	if _, err := h.service.DeclineOrder(r.PathValue("id"), ""); err != nil {
		writeOrdersActionError(w, err)
		return
	}
	h.renderQueueFragment(w, r, "/orders/{id}/decline")
}

// writeOrdersActionError maps an *orders.OrderError (see
// internal/orders/service.go) to the same status internal/orders/handlers.go's
// own writeOrderError would answer with, rendered as an HTML fragment
// instead of a JSON body — the same split writeFragmentError already draws
// for every other write action in this package.
func writeOrdersActionError(w http.ResponseWriter, err error) {
	var oe *orders.OrderError
	if errors.As(err, &oe) {
		writeFragmentError(w, oe.Status, oe.Message)
		return
	}
	httputil.InternalError(w, "web", err)
}

// ── Customer menu / order form ────────────────────────────────────────

// activeBeanOptions builds the order form's optional bean <select> from
// library.GetActiveBeans — the exact same stock-aware, disabled-bean-
// excluding projection GET /api/orders/active-beans already answers with
// (internal/orders/handlers.go's activeBeans), reused here rather than
// duplicated.
func (h *OrdersHandlers) activeBeanOptions() ([]templates.BeanOption, error) {
	lib, err := h.libRepo.GetLibrary()
	if err != nil {
		return nil, err
	}
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		return nil, err
	}
	active := library.GetActiveBeans(lib, doseRows)
	beans := make([]templates.BeanOption, 0, len(active))
	for _, b := range active {
		id, ok := beanOptionID(b["id"])
		if !ok {
			continue
		}
		name, _ := b["name"].(string)
		beans = append(beans, templates.BeanOption{ID: id, Name: name})
	}
	return beans, nil
}

// menuPage ports GET /menu: the customer ordering form, or one of the two
// non-form states templates.MenuPage renders (feature disabled, shop
// closed) — see that template's own doc comment.
func (h *OrdersHandlers) menuPage(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := templates.MenuPage(false, false, nil, nil, "").Render(r.Context(), w); err != nil {
			log.Printf("web: rendering /menu (disabled): %v", err)
		}
		return
	}
	settings, err := h.repo.GetSettings()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	shopOpen, _ := settings["enabled"].(bool)

	menu, err := h.repo.GetMenu()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	items := make([]templates.MenuItemOption, 0, len(menu))
	for _, m := range menu {
		name, _ := m["name"].(string)
		emoji, _ := m["emoji"].(string)
		if emoji == "" {
			emoji = "☕"
		}
		items = append(items, templates.MenuItemOption{Name: name, Emoji: emoji})
	}

	beans, err := h.activeBeanOptions()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MenuPage(true, shopOpen, items, beans, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /menu: %v", err)
	}
}

// placeOrderAction ports the htmx `hx-post="/menu/order"` interaction onto
// orders.Service.PlaceOrder — the same function POST /api/orders' own
// placeOrder handler calls (internal/orders/handlers.go), minus that
// handler's HA-notify side effect (this page has no barista-notify
// dependency to wire, and the REST path already covers that surface for any
// consumer that needs it). Validates exactly the two fields PlaceOrder's own
// caller-side checks require (item present and a known menu name, customer
// non-empty) — the same "item and customer required" / "unknown item" pair
// routes/orders.js's own placeOrder enforces before ever calling the service.
func (h *OrdersHandlers) placeOrderAction(w http.ResponseWriter, r *http.Request) {
	if !orders.IsOrdersEnabled() {
		writeFragmentError(w, http.StatusNotFound, "Orders feature not enabled")
		return
	}
	if !h.rl.Allow("web-menu:"+auth.RemoteIP(r), 10) {
		writeFragmentError(w, http.StatusTooManyRequests, "Too many requests — please slow down")
		return
	}
	settings, err := h.repo.GetSettings()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if enabled, _ := settings["enabled"].(bool); !enabled {
		writeFragmentError(w, http.StatusServiceUnavailable, "Not accepting orders right now")
		return
	}

	if err := r.ParseForm(); err != nil {
		writeFragmentError(w, http.StatusBadRequest, "Invalid form submission")
		return
	}
	item := r.FormValue("item")
	customer := strings.TrimSpace(r.FormValue("customer"))
	if item == "" || customer == "" {
		writeFragmentError(w, http.StatusBadRequest, "Name and item are required")
		return
	}
	menu, err := h.repo.GetMenu()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	found := false
	for _, m := range menu {
		if n, _ := m["name"].(string); n == item {
			found = true
			break
		}
	}
	if !found {
		writeFragmentError(w, http.StatusBadRequest, "Unknown menu item")
		return
	}

	var beanID any
	if raw := r.FormValue("beanId"); raw != "" {
		beanID = raw
	}

	order, err := h.service.PlaceOrder(orders.PlaceOrderInput{
		Item: item, Customer: customer, Note: r.FormValue("note"), BeanID: beanID,
	})
	if err != nil {
		writeOrdersActionError(w, err)
		return
	}

	orderedItem, _ := order["item"].(string)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MenuOrderResult(orderedItem, customer).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /menu/order result: %v", err)
	}
}
