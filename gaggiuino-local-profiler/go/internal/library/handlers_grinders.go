package library

import (
	"errors"
	"log"
	"net/http"
	"time"
)

// This file implements the grinder endpoints.

// createGrinder handles POST /api/library/grinder — a thin wrapper around
// CreateGrinder (create.go).
func (h *Handlers) createGrinder(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	grinder, err := CreateGrinder(h.repo, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, grinder)
}

// updateGrinder handles PUT /api/library/grinder/:id — a thin wrapper around
// UpdateGrinder (update.go).
func (h *Handlers) updateGrinder(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	grinder, found, err := UpdateGrinder(h.repo, id, body)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, grinder)
}

// setGrinderZeroPoint handles PUT /api/library/grinder/:id/zero-point: logs
// a new zero-point activation (see zero_point.go) so grind-setting
// suggestions/comparisons can correct for drift after a cleaning without
// every past shot's recorded grindSetting needing to be rewritten.
// Optional body field `since` (ms epoch int) enables retroactive entries;
// omit or pass 0 to use the current time (existing behaviour).
func (h *Handlers) setGrinderZeroPoint(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	if noMatch {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	zeroPoint, ok := jsParseFloat(body["zeroPoint"])
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid zeroPoint")
		return
	}
	var since int64
	if sv, ok2 := body["since"]; ok2 {
		sv64, ok3 := jsParseIntLoose(sv)
		if !ok3 {
			writeError(w, http.StatusBadRequest, "invalid since")
			return
		}
		if sv64 < 0 {
			writeError(w, http.StatusBadRequest, "since must not be negative")
			return
		}
		if sv64 > time.Now().UnixMilli() {
			writeError(w, http.StatusBadRequest, "since must not be in the future")
			return
		}
		since = sv64
	}
	grinder, found, err := SetGrinderZeroPoint(h.repo, id, zeroPoint, since)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, grinder)
}

// deleteGrinderZeroPoint handles DELETE /api/library/grinder/:id/zero-point/:since.
// Removes the zero-point history entry with the given since value (ms epoch).
// Silently succeeds when no such entry exists (idempotent).
func (h *Handlers) deleteGrinderZeroPoint(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	since, sinceNoMatch := parseIDParam(r.PathValue("since"))
	if noMatch || sinceNoMatch {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	grinder, found, err := DeleteGrinderZeroPointEntry(h.repo, id, since)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, grinder)
}

// resetBurrs handles POST /api/library/grinder/:id/reset-burrs.
func (h *Handlers) resetBurrs(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	var grinder Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findEntityIndex(lib.Grinders, id)
		}
		if idx == -1 {
			return errNotFound
		}
		grinder = lib.Grinders[idx]
		grinder["burrsResetAt"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		lib.Grinders[idx] = grinder
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.withWear(grinder))
}

// deleteGrinder handles POST /api/library/grinder/:id/delete: also removes
// its photo and its `grinder_{id}` row in the `maintenance` table, via the
// onGrinderDelete callback SetOnGrinderDeleted wires — see that method's doc
// comment for why this is a callback rather than a direct
// internal/maintenance import. Best-effort: a callback error is logged rather
// than failing the whole delete, since the grinder itself is already gone from
// the library at that point and there's nothing left to roll back.
func (h *Handlers) deleteGrinder(w http.ResponseWriter, r *http.Request) {
	h.deleteEntity(w, r, grinderKind, h.afterGrinderDelete)
}

// afterGrinderDelete is the post-delete cleanup deleteGrinder registers: the
// maintenance-row removal, logged rather than fatal (see deleteGrinder). It is
// attempted unconditionally — even for a param that matched no real grinder —
// matching dev, where grinder_{NaN} simply isn't a key in maint either, a
// silent no-op there too.
func (h *Handlers) afterGrinderDelete(id int64) {
	if h.onGrinderDelete == nil {
		return
	}
	if err := h.onGrinderDelete(id); err != nil {
		log.Printf("library: grinder %d delete follow-up failed: %v", id, err)
	}
}

// getGrinderImage handles GET /api/library/grinder/:id/image.
func (h *Handlers) getGrinderImage(w http.ResponseWriter, r *http.Request) {
	h.getEntityImage(w, r, grinderKind)
}

// postGrinderImage handles POST /api/library/grinder/:id/image.
func (h *Handlers) postGrinderImage(w http.ResponseWriter, r *http.Request) {
	h.postEntityImage(w, r, grinderKind, writeEntityJSON)
}
