package library

import (
	"errors"
	"net/http"
)

// This file ports routes/library/milks.js.

func findMilkIndex(lib Library, id int64) int {
	for i, m := range lib.Milks {
		if mid, ok := idOf(m, "id"); ok && mid == id {
			return i
		}
	}
	return -1
}

// listMilks ports GET /api/library/milks — a lightweight
// id/name/emoji/stockMl projection, defaulting emoji to the milk-carton
// emoji when unset.
func (h *Handlers) listMilks(w http.ResponseWriter, r *http.Request) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	out := make([]Entity, 0, len(lib.Milks))
	for _, m := range lib.Milks {
		emoji, _ := m["emoji"].(string)
		if emoji == "" {
			emoji = "🥛"
		}
		out = append(out, Entity{"id": m["id"], "name": m["name"], "emoji": emoji, "stockMl": m["stockMl"]})
	}
	writeJSON(w, http.StatusOK, out)
}

// createMilk ports POST /api/library/milk — a thin wrapper around
// CreateMilk (create.go), the same logic internal/web's "New milk" form
// also calls.
func (h *Handlers) createMilk(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	milk, _, err := CreateMilk(h.repo, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, milk)
}

// updateMilk ports PUT /api/library/milk/:id — a thin wrapper around
// UpdateMilk (update.go), the same logic internal/web's Edit milk form also
// calls.
func (h *Handlers) updateMilk(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	milk, _, found, err := UpdateMilk(h.repo, id, body)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, milk)
}

// deleteMilk ports DELETE /api/library/milk/:id.
func (h *Handlers) deleteMilk(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	filtered := make([]Entity, 0, len(lib.Milks))
	for _, m := range lib.Milks {
		mid, ok := idOf(m, "id")
		if !noMatch && ok && mid == id {
			continue
		}
		filtered = append(filtered, m)
	}
	lib.Milks = filtered
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// deductMilk ports POST /api/library/milk/:id/deduct.
func (h *Handlers) deductMilk(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	ml := floatOrZero(body["ml"])
	if ml <= 0 {
		writeError(w, http.StatusBadRequest, "ml must be positive")
		return
	}
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findMilkIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	milk := lib.Milks[idx]
	current := floatOrZero(milk["stockMl"])
	remaining := current - ml
	if remaining < 0 {
		remaining = 0
	}
	milk["stockMl"] = remaining
	milk["updatedAt"] = newID()
	lib.Milks[idx] = milk
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, milk)
}

// restockMilk ports POST /api/library/milk/:id/restock (#931): an additive
// server-side top-up, mirroring deductMilk above. Replaces the frontend's
// old absolute-overwrite PUT — the "Restock" button implies adding a fresh
// carton to what's left, and a client-computed current+val PUT would let
// two concurrent restocks race and drop one.
func (h *Handlers) restockMilk(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	ml := floatOrZero(body["ml"])
	if ml <= 0 {
		writeError(w, http.StatusBadRequest, "ml must be positive")
		return
	}
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findMilkIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	milk := lib.Milks[idx]
	milk["stockMl"] = floatOrZero(milk["stockMl"]) + ml
	milk["updatedAt"] = newID()
	lib.Milks[idx] = milk
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, milk)
}
