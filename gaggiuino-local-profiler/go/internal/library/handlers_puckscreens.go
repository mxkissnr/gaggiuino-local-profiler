package library

import (
	"errors"
	"net/http"
)

// This file implements the puckscreen endpoints (#635).

var puckScreenThicknesses = map[string]bool{"very-thin": true, "thin": true, "medium": true, "thick": true}

// listPuckScreens serves GET /api/library/puckscreens.
func (h *Handlers) listPuckScreens(w http.ResponseWriter, r *http.Request) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lib.PuckScreens)
}

// createPuckScreen handles POST /api/library/puckscreen — a thin wrapper
// around CreatePuckScreen (create.go).
func (h *Handlers) createPuckScreen(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	puckScreen, err := CreatePuckScreen(h.repo, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, puckScreen)
}

// updatePuckScreen handles PUT /api/library/puckscreen/:id — a thin wrapper
// around UpdatePuckScreen (update.go).
func (h *Handlers) updatePuckScreen(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	puckScreen, found, err := UpdatePuckScreen(h.repo, id, body)
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
	writeJSON(w, http.StatusOK, puckScreen)
}

// deletePuckScreen handles DELETE /api/library/puckscreen/:id.
func (h *Handlers) deletePuckScreen(w http.ResponseWriter, r *http.Request) {
	h.deleteEntity(w, r, puckScreenKind, nil)
}

// getPuckScreenImage handles GET /api/library/puckscreen/:id/image.
func (h *Handlers) getPuckScreenImage(w http.ResponseWriter, r *http.Request) {
	h.getEntityImage(w, r, puckScreenKind)
}

// postPuckScreenImage handles POST /api/library/puckscreen/:id/image.
func (h *Handlers) postPuckScreenImage(w http.ResponseWriter, r *http.Request) {
	h.postEntityImage(w, r, puckScreenKind, writeEntityJSON)
}
