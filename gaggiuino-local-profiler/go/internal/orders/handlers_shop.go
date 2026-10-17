package orders

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

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

// notifyToggleKeys are the settings keys that toggle a notification (#603).
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
	var enabled bool
	hasEnabled := false
	if raw, present := body["enabled"]; present {
		var isBool bool
		enabled, isBool = raw.(bool)
		if !isBool {
			writeError(w, http.StatusBadRequest, "enabled must be a boolean")
			return
		}
		hasEnabled = true
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
	if hasEnabled {
		s["enabled"] = enabled
	}
	if _, ok := body["broadcastRecipients"].([]any); ok {
		s["broadcastRecipients"] = normalizeRecipients(body["broadcastRecipients"])
	}
	if v, present := body["baristaNotifyService"]; present {
		s["baristaNotifyService"] = normalizeBaristaNotifyService(v)
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
		// Fire-and-forget: the response must not wait on HA/person lookups.
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

// broadcastShopState sends an HA push notification to every recipient
// currently home (or with no person mapping at all) when `enabled` flips
// true->false or false->true.
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
