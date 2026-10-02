package library

import (
	"errors"
	"net/http"
)

// This file implements the milk endpoints.

func findMilkIndex(lib Library, id int64) int {
	for i, m := range lib.Milks {
		if mid, ok := idOf(m, "id"); ok && mid == id {
			return i
		}
	}
	return -1
}

// listMilks serves GET /api/library/milks — a lightweight
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

// createMilk handles POST /api/library/milk — a thin wrapper around
// CreateMilk (create.go).
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

// updateMilk handles PUT /api/library/milk/:id — a thin wrapper around
// UpdateMilk (update.go).
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

// deleteMilk handles DELETE /api/library/milk/:id.
func (h *Handlers) deleteMilk(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	err := h.repo.Update(func(lib *Library) error {
		filtered := make([]Entity, 0, len(lib.Milks))
		removed := false
		for _, m := range lib.Milks {
			mid, ok := idOf(m, "id")
			if !noMatch && ok && mid == id {
				removed = true
				continue
			}
			filtered = append(filtered, m)
		}
		if !removed {
			return ErrSkipSave
		}
		lib.Milks = filtered
		return nil
	})
	if err != nil && !errors.Is(err, ErrSkipSave) {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// deductMilk handles POST /api/library/milk/:id/deduct.
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
	var milk Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findMilkIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		milk = lib.Milks[idx]
		current := floatOrZero(milk["stockMl"])
		remaining := current - ml
		if remaining < 0 {
			remaining = 0
		}
		milk["stockMl"] = remaining
		milk["updatedAt"] = newID()
		lib.Milks[idx] = milk
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, milk)
}

// restockMilk handles POST /api/library/milk/:id/restock (#931): an additive
// server-side top-up, like deductMilk above. Replaces the frontend's old
// absolute-overwrite PUT — the "Restock" button implies adding a fresh
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
	var milk Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findMilkIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		milk = lib.Milks[idx]
		milk["stockMl"] = floatOrZero(milk["stockMl"]) + ml
		milk["updatedAt"] = newID()
		lib.Milks[idx] = milk
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, milk)
}
