package library

import (
	"errors"
	"net/http"
)

// This file ports routes/library/recipes.js.

var validBrewMethods = map[string]bool{
	"espresso": true, "aeropress": true, "v60": true, "french_press": true,
	"moka": true, "cold_brew": true, "other": true,
}

func findRecipeIndex(lib Library, id int64) int {
	for i, rc := range lib.Recipes {
		if rid, ok := idOf(rc, "id"); ok && rid == id {
			return i
		}
	}
	return -1
}

// parseSteps ports routes/library/recipes.js's local _parseSteps: up to 30
// {text, duration_s} steps, entries with a blank text dropped entirely.
func parseSteps(raw any) []any {
	arr, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for i, item := range arr {
		if i >= 30 {
			break
		}
		step, _ := item.(Entity)
		text := trimMax(step["text"], 500)
		if text == "" {
			continue
		}
		out = append(out, Entity{"text": text, "duration_s": floatOrNilFalsy(step["duration_s"])})
	}
	return out
}

func brewMethodOrOther(v any) string {
	s, ok := v.(string)
	if ok && validBrewMethods[s] {
		return s
	}
	return "other"
}

// createRecipe ports POST /api/library/recipe — a thin wrapper around
// CreateRecipe (create.go), the same logic internal/web's "New recipe" form
// also calls.
func (h *Handlers) createRecipe(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	recipe, _, err := CreateRecipe(h.repo, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, recipe)
}

// updateRecipe ports PUT /api/library/recipe/:id — a thin wrapper around
// UpdateRecipe (update.go), the same logic internal/web's Edit recipe form
// also calls.
func (h *Handlers) updateRecipe(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	recipe, _, found, err := UpdateRecipe(h.repo, id, body)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, recipe)
}

// deleteRecipe ports POST /api/library/recipe/:id/delete.
func (h *Handlers) deleteRecipe(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	filtered := make([]Entity, 0, len(lib.Recipes))
	for _, rc := range lib.Recipes {
		rid, ok := idOf(rc, "id")
		if !noMatch && ok && rid == id {
			continue
		}
		filtered = append(filtered, rc)
	}
	lib.Recipes = filtered
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
