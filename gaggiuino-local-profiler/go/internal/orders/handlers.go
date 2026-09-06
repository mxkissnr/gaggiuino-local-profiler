package orders

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports routes/orders.js's Express router onto Go 1.22+'s
// method-and-wildcard http.ServeMux, the same pattern established in
// shots/handlers.go and library/handlers.go.
//
// _broadcastShopState (the shop-open/shop-closed HA-notify broadcast POST
// /api/orders/settings triggers when `enabled` flips) IS ported below
// (postSettings), now that internal/system (#901 Phase 1g) exists and
// exposes the default machine's live runtime state
// (machineOn/switchOnAt — lib/machine-runtime-state.js, populated by
// lib/poll.js's background polling loop) this needed. It's wired via
// SetPreheatInfoProvider's PreheatInfoFunc callback, NOT a direct import
// of internal/system: that package's own preheat-ready-notify feature
// would need this package's settings right back (notify_preheat_ready/
// baristaNotifyService), and importing each other directly would close a
// package cycle — see internal/system/doc.go's "internal/orders'
// shop-broadcast" section for the full reasoning. cmd/server wires
// ordersHandlers.SetPreheatInfoProvider(poller.PreheatInfo) after
// constructing both.
const jsonBodyLimit = 16 * 1024 // express.json({ limit: '16kb' }) — server.js's global default.

// PreheatInfoFunc ports _getPreheatInfo()'s return shape: whether the
// default machine is currently within its configured preheat window, and
// how many minutes remain if not.
type PreheatInfoFunc func() (ready bool, remainingMin int)

// Handlers wires Service (+ Repository, the machines registry, and the HA
// client) into net/http handlers.
type Handlers struct {
	service     *Service
	repo        *Repository
	registry    *machines.Registry
	ha          *ha.Client
	rl          *ratelimit.KeyedLimiter
	preheatInfo PreheatInfoFunc // nil until SetPreheatInfoProvider is called
}

// NewHandlers builds Handlers. shotsRepo/libRepo/registry are the same
// *sql.DB-backed dependencies cmd/server already opens once and shares
// across every domain package (see shots.NewRepository's own call site in
// main.go); haClient is internal/ha.NewClientFromEnv()'s result.
func NewHandlers(repo *Repository, shotsRepo *shots.Repository, libRepo *library.Repository, registry *machines.Registry, haClient *ha.Client) *Handlers {
	return &Handlers{
		service:  NewService(repo, shotsRepo, libRepo, registry, haClient),
		repo:     repo,
		registry: registry,
		ha:       haClient,
		rl:       ratelimit.NewKeyed(),
	}
}

// Service exposes h's own *Service instance — #901 code review (CONFIRMED
// finding #2): internal/web's OrdersHandlers builds a SECOND, independent
// *orders.Service around the same repositories (see that package's own
// NewOrdersHandlers doc comment for why: it needs Service.AcceptOrder et
// al.'s customer-notification side effect, which the REST-only *Handlers
// here doesn't expose otherwise), and only THAT second instance had its
// OnQueueChanged callback wired to the SSE hub — an order mutated through
// this package's own REST API (routes/orders.js's equivalent; used by
// glp-integration and any other external client) went through THIS
// Service instance instead, so it never published a live orders-update
// event despite go/README.md documenting "regardless of caller — the REST
// API included". cmd/server's main.go now wires this Service's own
// OnQueueChanged to the same publish function as the web instance's,
// closing that gap without collapsing the two *Service instances into one
// (which would need a larger constructor-signature change across three
// call sites for no behavior difference — both instances reading/writing
// the same underlying DB rows makes "publish from either" equivalent to
// "publish from one shared instance" here).
func (h *Handlers) Service() *Service {
	return h.service
}

// SetPreheatInfoProvider wires the shop-open broadcast's "is the machine
// ready, or how many minutes until it is" text to internal/system's
// Poller — see this file's header comment. A nil provider (the zero value,
// before cmd/server calls this) makes _broadcastShopState's opened branch
// report "not ready, 20 min" (loadPreheatMinutes()'s own default), rather
// than panicking — only cmd/server's real wiring should ever leave this
// unset, but tests that don't care about the broadcast text shouldn't have
// to supply one either.
func (h *Handlers) SetPreheatInfoProvider(fn PreheatInfoFunc) {
	h.preheatInfo = fn
}

// RegisterRoutes registers every /api/orders* route onto mux, each wrapped
// by the isOrdersEnabled gate routes/orders.js's router.use('/api/orders',
// ...) applies to the whole subtree.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	gate := h.withOrdersGate

	// Phase 2a (#901): routes/system.js's GET /api/menu — the public drink
	// list for shot annotations, deliberately NOT behind the isOrdersEnabled
	// gate (loadMenu() === orderRepo.getMenu(), so it's this same handler,
	// just ungated). Lives here rather than internal/system because this
	// package owns the orders Repository getMenu reads from.
	mux.HandleFunc("GET /api/menu", h.getMenu)

	mux.HandleFunc("GET /api/orders/menu", gate(h.getMenu))
	mux.HandleFunc("POST /api/orders/menu", gate(h.postMenu))
	mux.HandleFunc("PUT /api/orders/menu/{id}", gate(h.putMenuItem))
	mux.HandleFunc("DELETE /api/orders/menu/{id}", gate(h.deleteMenuItem))

	mux.HandleFunc("GET /api/orders/milk-stock", gate(h.milkStock))
	mux.HandleFunc("GET /api/orders/active-beans", gate(h.activeBeans))
	mux.HandleFunc("GET /api/orders/active-milks", gate(h.activeMilks))

	mux.HandleFunc("GET /api/orders/settings", gate(h.getSettings))
	mux.HandleFunc("POST /api/orders/settings", gate(h.postSettings))

	mux.HandleFunc("GET /api/orders/queue-eta", gate(h.queueEta))

	mux.HandleFunc("GET /api/orders/notify-services", gate(h.notifyServices))
	mux.HandleFunc("GET /api/orders/notify-mapping", gate(h.getNotifyMapping))
	mux.HandleFunc("POST /api/orders/notify-mapping", gate(h.postNotifyMapping))

	mux.HandleFunc("GET /api/orders/stats", gate(h.stats))
	mux.HandleFunc("GET /api/orders/mine", gate(h.mine))

	mux.HandleFunc("GET /api/orders", gate(h.listOrders))
	mux.HandleFunc("POST /api/orders", gate(h.placeOrder))

	mux.HandleFunc("POST /api/orders/{id}/accept", gate(h.accept))
	mux.HandleFunc("POST /api/orders/{id}/complete", gate(h.complete))
	mux.HandleFunc("POST /api/orders/{id}/decline", gate(h.decline))

	mux.HandleFunc("DELETE /api/orders/history", gate(h.deleteHistory))
	mux.HandleFunc("DELETE /api/orders/{id}", gate(h.deleteOrder))
}

// withOrdersGate ports the isOrdersEnabled 404 guard every /api/orders*
// route sits behind.
func (h *Handlers) withOrdersGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isOrdersEnabled() {
			writeError(w, http.StatusNotFound, "orders feature not enabled")
			return
		}
		next(w, r)
	}
}

// ── response/body helpers (see internal/httputil) ───────────────────────

var (
	writeJSON  = httputil.WriteJSON
	writeError = httputil.WriteError
)

func internalError(w http.ResponseWriter, err error) {
	httputil.InternalError(w, "orders", err)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, jsonBodyLimit)
	if !ok {
		return nil, false
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, true
}

// decodeOptionalJSONBody decodes a request body that's allowed to be
// entirely absent (POST /api/orders/:id/accept|decline's `eta`/`reason`
// fields — routes/orders.js reads them via `req.body?.eta`, never
// requiring a body at all, unlike decodeJSONBody's callers, which all
// guard a required field with their own ValidateX check afterward). An
// empty body decodes to {}, matching Express's own req.body for a
// bodyless request; a non-empty body still goes through the same
// size-limit/malformed-JSON handling decodeJSONBody applies.
func decodeOptionalJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	if r.ContentLength == 0 {
		return map[string]any{}, true
	}
	return decodeJSONBody(w, r)
}

func writeOrderError(w http.ResponseWriter, err error) {
	var oe *OrderError
	if errors.As(err, &oe) {
		writeError(w, oe.Status, oe.Message)
		return
	}
	internalError(w, err)
}

// sanitizeEmoji ports routes/orders.js's sanitizeEmoji(raw, fallback).
func sanitizeEmoji(raw any, fallback string) string {
	s, _ := raw.(string)
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return fallback
	}
	if len([]rune(trimmed)) > 8 || strings.ContainsAny(trimmed, "<>&\"'") {
		return fallback
	}
	return trimmed
}

func strField(body map[string]any, key string) string {
	s, _ := body[key].(string)
	return s
}

func trimMax(v any, max int) string {
	s, _ := v.(string)
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

func stringSliceMax(raw any, itemMax int) []any {
	arr, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	out := make([]any, 0, len(arr))
	for _, v := range arr {
		s := trimMax(toStringAny(v), itemMax)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func toStringAny(v any) any {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return ""
	}
}

// ── Menu ─────────────────────────────────────────────────────────────────

func (h *Handlers) getMenu(w http.ResponseWriter, r *http.Request) {
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, menu)
}

func (h *Handlers) postMenu(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	name := trimMax(body["name"], 200)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
		return
	}
	item := MenuItem{
		"id": "m_" + strconv.FormatInt(time.Now().UnixMilli(), 10), "name": name,
		"emoji": sanitizeEmoji(body["emoji"], "☕"), "createdAt": time.Now().UnixMilli(), "trending": false,
		"variants": stringSliceMax(body["variants"], 50),
		"useBeans": boolOf(body["useBeans"]), "useMilks": boolOf(body["useMilks"]),
	}
	menu = append(menu, item)
	if err := h.repo.SaveMenu(menu); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// boolOf ports JS's `!!v` truthiness coercion (routes/orders.js's
// `!!req.body.useBeans`) — a present, non-empty, non-zero value of any
// type is truthy, not just a literal JSON boolean.
func boolOf(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case nil:
		return false
	default:
		return true
	}
}

func (h *Handlers) putMenuItem(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	for i, m := range menu {
		if mid, _ := m["id"].(string); mid == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	item := menu[idx]
	if v := trimMax(body["name"], 200); v != "" {
		item["name"] = v
	}
	if v, ok := body["emoji"].(string); ok && strings.TrimSpace(v) != "" {
		fallback, _ := item["emoji"].(string)
		item["emoji"] = sanitizeEmoji(v, fallback)
	}
	if v, ok := body["trending"].(bool); ok {
		item["trending"] = v
	}
	if _, ok := body["variants"].([]any); ok {
		item["variants"] = stringSliceMax(body["variants"], 50)
	}
	if v, ok := body["useBeans"].(bool); ok {
		item["useBeans"] = v
	}
	if v, ok := body["useMilks"].(bool); ok {
		item["useMilks"] = v
	}
	if v, present := body["milkMl"]; present {
		if f, ok := v.(float64); ok {
			item["milkMl"] = f
		} else {
			item["milkMl"] = nil
		}
	}
	menu[idx] = item
	if err := h.repo.SaveMenu(menu); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (h *Handlers) deleteMenuItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
		return
	}
	filtered := make([]MenuItem, 0, len(menu))
	for _, m := range menu {
		if mid, _ := m["id"].(string); mid == id {
			continue
		}
		filtered = append(filtered, m)
	}
	if len(filtered) == len(menu) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := h.repo.SaveMenu(filtered); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Milk / beans ─────────────────────────────────────────────────────────

func (h *Handlers) milkStock(w http.ResponseWriter, r *http.Request) {
	lib, err := h.service.libRepo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
		return
	}
	active, err := h.repo.FindActive()
	if err != nil {
		internalError(w, err)
		return
	}
	var scoped []Order
	for _, o := range active {
		status, _ := o["status"].(string)
		if status == "pending" || status == "accepted" {
			scoped = append(scoped, o)
		}
	}
	out := make([]library.Entity, 0, len(lib.Milks))
	for _, m := range lib.Milks {
		mName, _ := m["name"].(string)
		var demand float64
		for _, o := range scoped {
			variant, _ := o["variant"].(string)
			if variant != mName {
				continue
			}
			item, _ := o["item"].(string)
			for _, mi := range menu {
				if n, _ := mi["name"].(string); n == item {
					if ml, ok := mi["milkMl"].(float64); ok {
						demand += ml
					}
					break
				}
			}
		}
		stockMl, _ := m["stockMl"].(float64)
		remaining := stockMl - demand
		if remaining < 0 {
			remaining = 0
		}
		entry := library.Entity{}
		for k, v := range m {
			entry[k] = v
		}
		entry["demand"] = demand
		entry["remaining"] = remaining
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handlers) activeBeans(w http.ResponseWriter, r *http.Request) {
	lib, err := h.service.libRepo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	doses, err := h.service.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, library.GetActiveBeans(lib, doses))
}

func (h *Handlers) activeMilks(w http.ResponseWriter, r *http.Request) {
	lib, err := h.service.libRepo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, library.GetActiveMilks(lib))
}

// ── Settings ─────────────────────────────────────────────────────────────

// notifyToggleKeys mirrors routes/orders.js's NOTIFY_TOGGLE_KEYS (#603).
var notifyToggleKeys = []string{
	"notify_preheat_ready", "notify_low_stock", "notify_shop_state",
	"notify_new_order", "notify_order_status",
}

func (h *Handlers) getSettings(w http.ResponseWriter, r *http.Request) {
	s, err := h.repo.GetSettings()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (h *Handlers) postSettings(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	enabled, isBool := body["enabled"].(bool)
	if !isBool {
		writeError(w, http.StatusBadRequest, "enabled (boolean) required")
		return
	}
	prev, err := h.repo.GetSettings()
	if err != nil {
		internalError(w, err)
		return
	}
	s := Settings{}
	for k, v := range prev {
		s[k] = v
	}
	s["enabled"] = enabled
	if arr, ok := body["broadcastRecipients"].([]any); ok {
		recipients := make([]any, 0, len(arr))
		for _, v := range arr {
			if str, ok := v.(string); ok && strings.HasPrefix(str, "notify.") {
				recipients = append(recipients, trimMax(str, 100))
			}
		}
		s["broadcastRecipients"] = recipients
	}
	if v, present := body["baristaNotifyService"]; present {
		if str, ok := v.(string); ok && strings.HasPrefix(str, "notify.") {
			s["baristaNotifyService"] = trimMax(str, 100)
		} else {
			s["baristaNotifyService"] = nil
		}
	}
	for _, key := range notifyToggleKeys {
		if v, ok := body[key].(bool); ok {
			s[key] = v
		}
	}
	if err := h.repo.SaveSettings(s); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
	recipients := stringSliceField(s, "broadcastRecipients")
	if len(recipients) > 0 {
		// Fire-and-forget, same as Node's un-awaited _broadcastShopState
		// call after res.json(s) — the response must not wait on HA/person
		// lookups.
		httputil.SafeGo("orders: broadcast shop state", func() { h.broadcastShopState(context.Background(), s, prev, recipients) })
	}
}

func stringSliceField(s Settings, key string) []string {
	arr, ok := s[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if str, ok := v.(string); ok {
			out = append(out, str)
		}
	}
	return out
}

// broadcastShopState ports _broadcastShopState(s, prev, recipients): sends
// an HA push notification to every recipient currently home (or with no
// person mapping at all) when `enabled` flips true->false or false->true.
func (h *Handlers) broadcastShopState(ctx context.Context, s, prev Settings, recipients []string) {
	opened, _ := s["enabled"].(bool)
	prevEnabled, _ := prev["enabled"].(bool)
	closed := !opened && prevEnabled
	opened = opened && !prevEnabled
	if !opened && !closed {
		return
	}
	if v, ok := s["notify_shop_state"].(bool); ok && !v {
		return
	}

	filtered := recipients
	persons := h.ha.GetPersons(ctx)
	if len(persons) > 0 {
		mapping, err := h.repo.GetNotifyMapping()
		if err == nil {
			svcToState := make(map[string]string, len(persons))
			for _, p := range persons {
				if svc, ok := mapping[p.HAUserID]; ok {
					svcToState[svc] = p.State
				}
			}
			kept := make([]string, 0, len(recipients))
			for _, svc := range recipients {
				if state, tracked := svcToState[svc]; !tracked || state == "home" {
					kept = append(kept, svc)
				}
			}
			filtered = kept
		}
	}
	if len(filtered) == 0 {
		return
	}

	if opened {
		ready, remainingMin := false, 20
		if h.preheatInfo != nil {
			ready, remainingMin = h.preheatInfo()
		}
		title := "⏳ Kaffee öffnet bald!"
		body := fmt.Sprintf("Die Maschine heizt noch auf. Kaffee öffnet in ca. %d Min. — Bestellungen über das Menü Kaffeebar.", remainingMin)
		if ready {
			title = "☕ Kaffee ist jetzt geöffnet!"
			body = "Die Maschine ist bereit — Bestellungen über das Menü Kaffeebar aufgeben."
		}
		for _, svc := range filtered {
			_ = h.ha.SendNotify(ctx, svc, title, body, "glp_shop_open")
		}
		log.Printf("orders: shop-open broadcast sent to %d/%d device(s) (home filter)", len(filtered), len(recipients))
	} else {
		for _, svc := range filtered {
			_ = h.ha.SendNotify(ctx, svc, "🚫 Kaffeebar geschlossen", "Die Bestellannahme wurde beendet.", "glp_shop_closed")
		}
		log.Printf("orders: shop-closed broadcast sent to %d/%d device(s) (home filter)", len(filtered), len(recipients))
	}
}

// ── Queue ETA ────────────────────────────────────────────────────────────

func (h *Handlers) queueEta(w http.ResponseWriter, r *http.Request) {
	orders, err := h.repo.FindActive()
	if err != nil {
		internalError(w, err)
		return
	}
	if machineParam := r.URL.Query().Get("machine"); machineParam != "" {
		machineID, _ := strconv.ParseInt(machineParam, 10, 64)
		filtered := orders[:0:0]
		for _, o := range orders {
			if matchesMachine(o, machineID) {
				filtered = append(filtered, o)
			}
		}
		orders = filtered
	}
	writeJSON(w, http.StatusOK, ComputeQueueEta(orders, time.Now()))
}

// ── Notify mapping ───────────────────────────────────────────────────────

func (h *Handlers) notifyServices(w http.ResponseWriter, r *http.Request) {
	svcs := h.ha.GetNotifyServices(r.Context())
	writeJSON(w, http.StatusOK, svcs)
}

func (h *Handlers) getNotifyMapping(w http.ResponseWriter, r *http.Request) {
	orders, err := h.repo.FindActive()
	if err != nil {
		internalError(w, err)
		return
	}
	mapping, err := h.repo.GetNotifyMapping()
	if err != nil {
		internalError(w, err)
		return
	}
	customers := map[string]string{}
	for _, o := range orders {
		haUserID, _ := o["haUserId"].(string)
		if haUserID == "" {
			continue
		}
		customer, _ := o["customer"].(string)
		customers[haUserID] = customer
	}
	for _, p := range h.ha.GetPersons(r.Context()) {
		if _, exists := customers[p.HAUserID]; !exists {
			customers[p.HAUserID] = p.Name
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"mapping": mapping, "customers": customers})
}

func (h *Handlers) postNotifyMapping(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	mapping, err := h.repo.GetNotifyMapping()
	if err != nil {
		internalError(w, err)
		return
	}
	for haUserID, raw := range body {
		svc, ok := raw.(string)
		if !ok {
			continue
		}
		if svc == "" {
			delete(mapping, haUserID)
		} else if strings.HasPrefix(svc, "notify.") {
			mapping[haUserID] = svc
		}
	}
	if err := h.repo.SaveNotifyMapping(mapping); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Orders list / mine / stats ──────────────────────────────────────────

func (h *Handlers) listOrders(w http.ResponseWriter, r *http.Request) {
	orders, err := h.repo.FindActive()
	if err != nil {
		internalError(w, err)
		return
	}
	if status := r.URL.Query().Get("status"); status != "" {
		filtered := orders[:0:0]
		for _, o := range orders {
			if s, _ := o["status"].(string); s == status {
				filtered = append(filtered, o)
			}
		}
		orders = filtered
	}
	if machineParam := r.URL.Query().Get("machine"); machineParam != "" {
		machineID, _ := strconv.ParseInt(machineParam, 10, 64)
		filtered := orders[:0:0]
		for _, o := range orders {
			if matchesMachine(o, machineID) {
				filtered = append(filtered, o)
			}
		}
		orders = filtered
	}
	reversed := make([]Order, len(orders))
	for i, o := range orders {
		reversed[len(orders)-1-i] = o
	}
	if len(reversed) > 100 {
		reversed = reversed[:100]
	}
	writeJSON(w, http.StatusOK, reversed)
}

type customerStat struct {
	Name      string
	Count     int
	Items     map[string]int
	ItemOrder []string
	LastAt    float64
}

func (h *Handlers) stats(w http.ResponseWriter, r *http.Request) {
	all, err := h.repo.FindAll()
	if err != nil {
		internalError(w, err)
		return
	}
	var done []Order
	for _, o := range all {
		if s, _ := o["status"].(string); s == "done" {
			done = append(done, o)
		}
	}

	// First-seen order, not map iteration order: JS builds machineCounts as
	// a plain object (Object.keys() then preserves insertion order) before
	// sorting by count — a Go map's range order is randomized, which would
	// only show up as a difference in how count-tied machines are ordered,
	// but is worth getting right for a byte-fidelity contract.
	machineCounts := map[int64]int{}
	var machineOrder []int64
	for _, o := range done {
		mid := orderMachineID(o)
		if _, seen := machineCounts[mid]; !seen {
			machineOrder = append(machineOrder, mid)
		}
		machineCounts[mid]++
	}
	var byMachine any
	if len(machineCounts) > 1 {
		machinesList, _ := h.registry.ListMachines()
		byName := map[int64]string{}
		for _, m := range machinesList {
			byName[m.ID] = m.Name
		}
		rows := make([]map[string]any, 0, len(machineCounts))
		for _, id := range machineOrder {
			var name any
			if n, ok := byName[id]; ok {
				name = n
			}
			rows = append(rows, map[string]any{"machineId": id, "machineName": name, "count": machineCounts[id]})
		}
		sortByCountDesc(rows)
		byMachine = rows
	}

	if machineParam := r.URL.Query().Get("machine"); machineParam != "" {
		machineID, _ := strconv.ParseInt(machineParam, 10, 64)
		filtered := done[:0:0]
		for _, o := range done {
			if matchesMachine(o, machineID) {
				filtered = append(filtered, o)
			}
		}
		done = filtered
	}

	if len(done) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"total": 0, "customers": []any{}, "mostPopular": nil, "byMachine": byMachine})
		return
	}

	byCustomer := map[string]*customerStat{}
	var customerOrder []string
	byItem := map[string]int{}
	var itemOrder []string
	for _, o := range done {
		customer, _ := o["customer"].(string)
		key := strings.ToLower(strings.TrimSpace(customer))
		cs, ok := byCustomer[key]
		if !ok {
			cs = &customerStat{Name: customer, Items: map[string]int{}}
			byCustomer[key] = cs
			customerOrder = append(customerOrder, key)
		}
		cs.Count++
		item, _ := o["item"].(string)
		if _, seen := cs.Items[item]; !seen {
			cs.ItemOrder = append(cs.ItemOrder, item)
		}
		cs.Items[item]++
		completedAt, _ := jsNumber(o["completedAt"])
		createdAt, _ := jsNumber(o["createdAt"])
		ts := completedAt
		if ts == 0 {
			ts = createdAt
		}
		if ts >= cs.LastAt {
			cs.LastAt = ts
			cs.Name = customer
		}
		if _, seen := byItem[item]; !seen {
			itemOrder = append(itemOrder, item)
		}
		byItem[item]++
	}

	customers := make([]map[string]any, 0, len(byCustomer))
	for _, key := range customerOrder {
		cs := byCustomer[key]
		customers = append(customers, map[string]any{
			"name": cs.Name, "count": cs.Count, "favItem": favItemOrdered(cs.Items, cs.ItemOrder), "lastAt": int64(cs.LastAt),
		})
	}
	sortCustomersDesc(customers)

	var mostPopular any
	if bestItem, bestCount, ok := mostPopularItemOrdered(byItem, itemOrder); ok {
		mostPopular = map[string]any{"item": bestItem, "count": bestCount}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total": len(done), "customers": customers, "mostPopular": mostPopular, "byMachine": byMachine,
	})
}

func favItemOrdered(items map[string]int, order []string) any {
	item, _, ok := mostPopularItemOrdered(items, order)
	if !ok {
		return nil
	}
	return item
}

// mostPopularItemOrdered ports `Object.entries(items).sort((a, b) =>
// b[1] - a[1])[0]`: highest count wins, first-seen (insertion order) wins a
// tie — Array.prototype.sort is stable, so a plain map-range reduction
// (whose iteration order Go randomizes) would only diverge from Node on a
// tied count, but `order` (each map's first-seen key sequence, tracked
// alongside it by the caller) restores that exact tie-break.
func mostPopularItemOrdered(items map[string]int, order []string) (string, int, bool) {
	best, bestCount := "", -1
	for _, item := range order {
		if count := items[item]; count > bestCount {
			best, bestCount = item, count
		}
	}
	return best, bestCount, bestCount >= 0
}

func sortByCountDesc(rows []map[string]any) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0; j-- {
			a := rows[j-1]["count"].(int)
			b := rows[j]["count"].(int)
			if a >= b {
				break
			}
			rows[j-1], rows[j] = rows[j], rows[j-1]
		}
	}
}

func sortCustomersDesc(rows []map[string]any) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0; j-- {
			a := rows[j-1]["count"].(int)
			b := rows[j]["count"].(int)
			if a >= b {
				break
			}
			rows[j-1], rows[j] = rows[j], rows[j-1]
		}
	}
}

func (h *Handlers) mine(w http.ResponseWriter, r *http.Request) {
	haUserID := r.Header.Get("X-GLP-HA-User-ID")
	if haUserID != "" {
		haUserID = trimMax(haUserID, 100)
	} else {
		haUserID = r.URL.Query().Get("haUserId")
	}
	if haUserID == "" {
		writeError(w, http.StatusBadRequest, "haUserId required")
		return
	}
	orders, err := h.repo.FindActive()
	if err != nil {
		internalError(w, err)
		return
	}
	var mine []Order
	for _, o := range orders {
		if id, _ := o["haUserId"].(string); id == haUserID {
			mine = append(mine, o)
		}
	}
	reversed := make([]Order, len(mine))
	for i, o := range mine {
		reversed[len(mine)-1-i] = o
	}
	if len(reversed) > 10 {
		reversed = reversed[:10]
	}
	writeJSON(w, http.StatusOK, reversed)
}

// ── Place order ──────────────────────────────────────────────────────────

func (h *Handlers) placeOrder(w http.ResponseWriter, r *http.Request) {
	if !h.rl.Allow("orders:"+auth.RemoteIP(r), 10) {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	settings, err := h.repo.GetSettings()
	if err != nil {
		internalError(w, err)
		return
	}
	if enabled, _ := settings["enabled"].(bool); !enabled {
		writeError(w, http.StatusServiceUnavailable, "orders_disabled")
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	item := strField(body, "item")
	customer := strings.TrimSpace(strField(body, "customer"))
	if item == "" || customer == "" {
		writeError(w, http.StatusBadRequest, "item and customer required")
		return
	}
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
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
		writeError(w, http.StatusBadRequest, "unknown item")
		return
	}

	haUserID := r.Header.Get("X-GLP-HA-User-ID")
	if haUserID != "" {
		haUserID = trimMax(haUserID, 100)
	} else {
		haUserID = trimMax(strField(body, "haUserId"), 100)
	}

	order, err := h.service.PlaceOrder(PlaceOrderInput{
		Item: item, Note: strField(body, "note"), Customer: customer,
		NotifyService: strField(body, "notifyService"), Variant: strField(body, "variant"),
		Machine: strField(body, "machine"), HAUserID: haUserID, BeanID: body["beanId"],
	})
	if err != nil {
		writeOrderError(w, err)
		return
	}

	if settings["baristaNotifyService"] != nil {
		if notifyOrderStatus, ok := settings["notify_new_order"].(bool); !ok || notifyOrderStatus {
			svc, _ := settings["baristaNotifyService"].(string)
			itemLabel, _ := order["item"].(string)
			if variant, _ := order["variant"].(string); variant != "" {
				itemLabel = itemLabel + " · " + variant
			}
			body := customer
			if note, _ := order["note"].(string); note != "" {
				body = customer + ": " + note
			}
			go h.ha.SendNotify(context.Background(), svc, "☕ "+itemLabel, body, "glp_new_order")
		}
	}

	writeJSON(w, http.StatusOK, order)
}

// ── Order actions ────────────────────────────────────────────────────────
//
// accept/complete/decline no longer build and send the customer HA
// notification themselves — that now lives on Service.AcceptOrder/
// CompleteOrder/DeclineOrder (internal/orders/service.go's
// notifyOrderStatus), so every caller of those three methods gets it,
// including internal/web's htmx queue actions (#901 code review).

func (h *Handlers) accept(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeOptionalJSONBody(w, r)
	if !ok {
		return
	}
	order, err := h.service.AcceptOrder(r.PathValue("id"), body["eta"])
	if err != nil {
		writeOrderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func (h *Handlers) complete(w http.ResponseWriter, r *http.Request) {
	order, err := h.service.CompleteOrder(r.PathValue("id"))
	if err != nil {
		writeOrderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func (h *Handlers) decline(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeOptionalJSONBody(w, r)
	if !ok {
		return
	}
	reason, _ := body["reason"].(string)
	order, err := h.service.DeclineOrder(r.PathValue("id"), reason)
	if err != nil {
		writeOrderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, order)
}

// ── History delete ───────────────────────────────────────────────────────

func (h *Handlers) deleteHistory(w http.ResponseWriter, r *http.Request) {
	all, err := h.repo.FindAll()
	if err != nil {
		internalError(w, err)
		return
	}
	for _, o := range all {
		status, _ := o["status"].(string)
		if status == "done" || status == "declined" {
			id, _ := o["id"].(string)
			if err := h.repo.Delete(id); err != nil {
				internalError(w, err)
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) deleteOrder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	order, err := h.repo.FindByID(id)
	if err != nil {
		internalError(w, err)
		return
	}
	if order == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	status, _ := order["status"].(string)
	if status != "done" && status != "declined" {
		writeError(w, http.StatusBadRequest, "can only delete completed orders")
		return
	}
	if err := h.repo.Delete(id); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
