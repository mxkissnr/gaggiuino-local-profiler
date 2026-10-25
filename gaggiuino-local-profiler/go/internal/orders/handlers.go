package orders

import (
	"errors"
	"math"
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

// This file wires the orders HTTP handlers onto Go 1.22+'s
// method-and-wildcard http.ServeMux, the same pattern established in
// shots/handlers.go and library/handlers.go.
//
// The shop-open/shop-closed HA-notify broadcast POST /api/orders/settings
// triggers when `enabled` flips lives below (postSettings), using the
// default machine's live runtime state (machineOn/switchOnAt, read from
// internal/system). It's wired via SetPreheatInfoProvider's PreheatInfoFunc
// callback, NOT a direct import of internal/system: that package's own
// preheat-ready-notify feature would need this package's settings right back
// (notify_preheat_ready/baristaNotifyService), and importing each other
// directly would close a package cycle — see internal/system/doc.go's
// "internal/orders' shop-broadcast" section for the full reasoning.
// cmd/server wires ordersHandlers.SetPreheatInfoProvider(poller.PreheatInfo)
// after constructing both.
const jsonBodyLimit = 16 * 1024 // 16kb global JSON body limit.

// PreheatInfoFunc reports whether the default machine is currently within
// its configured preheat window, and how many minutes remain if not.
type PreheatInfoFunc func() (ready bool, remainingMin int)

// Handlers wires Service (+ Repository, the machines registry, and the HA
// client) into net/http handlers.
type Handlers struct {
	service     *Service
	repo        *Repository
	registry    *machines.Registry
	ha          *ha.Client
	rl          *ratelimit.KeyedLimiter
	preheatInfo PreheatInfoFunc     // nil until SetPreheatInfoProvider is called
	kioskKey    *auth.KioskKeyStore // nil until SetKioskKeyStore is called
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

// SetPreheatInfoProvider wires the shop-open broadcast's "is the machine
// ready, or how many minutes until it is" text to internal/system's
// Poller — see this file's header comment. A nil provider (the zero value,
// before cmd/server calls this) makes the shop-broadcast's opened branch
// fall back to "not ready, 20 min", rather
// than panicking — only cmd/server's real wiring should ever leave this
// unset, but tests that don't care about the broadcast text shouldn't have
// to supply one either.
func (h *Handlers) SetPreheatInfoProvider(fn PreheatInfoFunc) {
	h.preheatInfo = fn
}

// RegisterRoutes registers every /api/orders* route onto mux, each wrapped
// by the isOrdersEnabled gate that applies to the whole /api/orders subtree.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	gate := h.withOrdersGate

	// GET /api/menu serves the public drink list for shot annotations,
	// deliberately NOT behind the isOrdersEnabled gate: the menu the orders
	// Repository returns is the same data, just ungated. Lives here rather
	// than internal/system because this package owns the orders Repository
	// getMenu reads from.
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

	// #1731: the guest kiosk's orders-only key. Both routes stay behind the
	// full API token (they are deliberately absent from RequireToken's
	// kiosk allow-list), so a kiosk key cannot read — let alone rotate — its
	// own credential.
	mux.HandleFunc("GET /api/orders/kiosk-key", gate(h.getKioskKey))
	mux.HandleFunc("POST /api/orders/kiosk-key/rotate", gate(h.rotateKioskKey))
}

// withOrdersGate applies the isOrdersEnabled 404 guard every /api/orders*
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
// fields — both are optional, unlike decodeJSONBody's callers, which all
// guard a required field with their own ValidateX check afterward). An
// empty body decodes to {}, the same as a bodyless request; a non-empty
// body still goes through the same size-limit/malformed-JSON handling
// decodeJSONBody applies.
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

// sanitizeEmoji validates raw as a short emoji, returning fallback otherwise.
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

// milkMlOrNil parses the menu item's milk amount. External callers (Home
// Assistant templates, for instance) often send the amount as a JSON string,
// which a float64-only type assertion would drop silently; a non-positive,
// NaN or infinite value — and an unparseable one — collapses to nil.
func milkMlOrNil(v any) any {
	var f float64
	switch t := v.(type) {
	case float64:
		f = t
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return nil
		}
		f = parsed
	default:
		return nil
	}
	if f <= 0 || math.IsNaN(f) || math.IsInf(f, 0) { // 0, negative, NaN and ±Inf all collapse to null
		return nil
	}
	return f
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
	item, ok := NormalizeMenuItem(body)
	if !ok {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	menu, err := h.repo.GetMenu()
	if err != nil {
		internalError(w, err)
		return
	}
	// The create path always stamps a fresh id/createdAt, as it did before
	// NormalizeMenuItem existed.
	item["id"] = "m_" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	item["createdAt"] = time.Now().UnixMilli()
	menu = append(menu, item)
	if err := h.repo.SaveMenu(menu); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// boolOf applies truthiness coercion — a present, non-empty, non-zero value
// of any type is truthy, not just a literal JSON boolean.
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
		item["milkMl"] = milkMlOrNil(v)
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
