package orders

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

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

	// First-seen order, not map iteration order: machineCounts is built in
	// insertion order before sorting by count — a Go map's range order is
	// randomized, which would only show up as a difference in how
	// count-tied machines are ordered, but is worth getting right for a
	// byte-fidelity contract.
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

// mostPopularItemOrdered returns the highest count, with first-seen
// (insertion order) winning a tie. A plain map-range reduction would have
// randomized iteration order, so `order` (each map's first-seen key
// sequence, tracked alongside it by the caller) supplies the deterministic
// tie-break.
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
// notifyOrderStatus), so every caller of those three methods gets it
// (#901 code review).

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
	if _, err := h.repo.DeleteFinished(); err != nil {
		internalError(w, err)
		return
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
