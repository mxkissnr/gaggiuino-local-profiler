package library

import (
	"errors"
	"net/http"
)

// This file implements the recipe endpoints.

var validBrewMethods = map[string]bool{
	"espresso": true, "aeropress": true, "v60": true, "french_press": true,
	"moka": true, "cold_brew": true, "other": true,
}

// parseSteps is the local steps parser: up to 30 {text, duration_s} steps,
// entries with a blank text dropped entirely.
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

// createRecipe handles POST /api/library/recipe — a thin wrapper around
// CreateRecipe (create.go).
func (h *Handlers) createRecipe(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	recipe, err := CreateRecipe(h.repo, body)
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

// updateRecipe handles PUT /api/library/recipe/:id — a thin wrapper around
// UpdateRecipe (update.go).
func (h *Handlers) updateRecipe(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	recipe, found, err := UpdateRecipe(h.repo, id, body)
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

// deleteRecipe handles POST /api/library/recipe/:id/delete.
func (h *Handlers) deleteRecipe(w http.ResponseWriter, r *http.Request) {
	h.deleteEntity(w, r, recipeKind, nil)
}
