package library

import (
	"errors"
	"net/http"
)

// This file implements the basket endpoints (#635).

var basketWallTypes = map[string]bool{"pressurized": true, "single-wall": true, "precision-machined": true, "high-flow": true}
var basketShapes = map[string]bool{"straight": true, "tapered": true}

// listBaskets serves GET /api/library/baskets.
func (h *Handlers) listBaskets(w http.ResponseWriter, r *http.Request) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lib.Baskets)
}

// createBasket handles POST /api/library/basket — a thin wrapper around
// CreateBasket (create.go).
func (h *Handlers) createBasket(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	basket, err := CreateBasket(h.repo, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, basket)
}

// updateBasket handles PUT /api/library/basket/:id — a thin wrapper around
// UpdateBasket (update.go).
func (h *Handlers) updateBasket(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	basket, found, err := UpdateBasket(h.repo, id, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, basket)
}

// deleteBasket handles DELETE /api/library/basket/:id.
func (h *Handlers) deleteBasket(w http.ResponseWriter, r *http.Request) {
	h.deleteEntity(w, r, basketKind, nil)
}

// getBasketImage handles GET /api/library/basket/:id/image.
func (h *Handlers) getBasketImage(w http.ResponseWriter, r *http.Request) {
	h.getEntityImage(w, r, basketKind)
}

// postBasketImage handles POST /api/library/basket/:id/image.
func (h *Handlers) postBasketImage(w http.ResponseWriter, r *http.Request) {
	h.postEntityImage(w, r, basketKind, writeEntityJSON)
}
