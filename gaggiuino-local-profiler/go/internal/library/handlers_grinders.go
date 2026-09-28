package library

import (
	"errors"
	"net/http"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file ports routes/library/grinders.js.

func findGrinderIndex(lib Library, id int64) int {
	for i, g := range lib.Grinders {
		if gid, ok := idOf(g, "id"); ok && gid == id {
			return i
		}
	}
	return -1
}

// createGrinder ports POST /api/library/grinder — a thin wrapper around
// CreateGrinder (create.go), the same logic internal/web's "New grinder"
// form also calls.
func (h *Handlers) createGrinder(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	grinder, _, err := CreateGrinder(h.repo, body)
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

// updateGrinder ports PUT /api/library/grinder/:id — a thin wrapper around
// UpdateGrinder (update.go), the same logic internal/web's Edit grinder form
// also calls.
func (h *Handlers) updateGrinder(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	grinder, _, found, err := UpdateGrinder(h.repo, id, body)
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

// resetBurrs ports POST /api/library/grinder/:id/reset-burrs.
func (h *Handlers) resetBurrs(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	var grinder Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findGrinderIndex(*lib, id)
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

// deleteGrinder ports POST /api/library/grinder/:id/delete: also removes
// its photo and (Phase 1f, #901) its `grinder_{id}` row in the
// `maintenance` table, via the onGrinderDelete callback SetOnGrinderDeleted
// wires — see that method's doc comment for why this is a callback rather
// than a direct internal/maintenance import. Best-effort: a callback error
// is swallowed (logged nowhere further — this package has no logger
// dependency of its own, matching every other best-effort call site here)
// rather than failing the whole delete, since the grinder itself is
// already gone from the library at that point and there's nothing left to
// roll back.
func (h *Handlers) deleteGrinder(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	var imgExt string
	// The image file removal below is filesystem I/O: it must not run while
	// Update holds the library write lock, so the closure only records the
	// extension and the handler deletes the file once Update returns.
	err := h.repo.Update(func(lib *Library) error {
		if !noMatch {
			if idx := findGrinderIndex(*lib, id); idx != -1 {
				if ext, _ := lib.Grinders[idx]["image"].(string); ext != "" {
					imgExt = ext
				}
			}
		}
		filtered := make([]Entity, 0, len(lib.Grinders))
		removed := false
		for _, g := range lib.Grinders {
			gid, ok := idOf(g, "id")
			if !noMatch && ok && gid == id {
				removed = true
				continue
			}
			filtered = append(filtered, g)
		}
		if !removed {
			return ErrSkipSave
		}
		lib.Grinders = filtered
		return nil
	})
	if err != nil && !errors.Is(err, ErrSkipSave) {
		internalError(w, err)
		return
	}
	if imgExt != "" {
		img.Delete(h.imageDir, id, imgExt, "grinder-")
	}
	// Matches routes/library/grinders.js's own unconditional attempt (even
	// for a param that didn't match any real grinder — `grinder_NaN` simply
	// isn't a key in `maint` either, a silent no-op there too).
	if h.onGrinderDelete != nil {
		_ = h.onGrinderDelete(id) // best-effort, matches Node's `catch { /* ignore */ }`
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// getGrinderImage ports GET /api/library/grinder/:id/image.
func (h *Handlers) getGrinderImage(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	ext := ""
	if !noMatch {
		if idx := findGrinderIndex(lib, id); idx != -1 {
			ext, _ = lib.Grinders[idx]["image"].(string)
		}
	}
	h.serveImage(w, r, ext, "grinder-", id)
}

// postGrinderImage ports POST /api/library/grinder/:id/image.
func (h *Handlers) postGrinderImage(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitImage(w, r) {
		return
	}
	id, noMatch := parseIDParam(r.PathValue("id"))
	// Existence is decided before the upload is read/validated or any file is
	// written: an unknown id 404s even when the image is also invalid, and no
	// orphan file is ever written (matching dev's ordering).
	exists, err := h.entityExists(id, noMatch, findGrinderIndex)
	if err != nil {
		internalError(w, err)
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	data, contentType, ok := readUploadedImage(w, r)
	if !ok {
		return
	}
	ext, ok := img.Save(h.imageDir, "grinder-", id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var grinder Entity
	var oldExt string
	err = h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findGrinderIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		grinder = lib.Grinders[idx]
		oldExt, _ = grinder["image"].(string)
		grinder["image"] = ext
		lib.Grinders[idx] = grinder
		return nil
	})
	if err != nil {
		// The entity was deleted between the existence check and the write;
		// the just-saved file has no owner, so drop it.
		img.Delete(h.imageDir, id, ext, "grinder-")
		writeUpdateError(w, err)
		return
	}
	if oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "grinder-")
	}
	writeJSON(w, http.StatusOK, grinder)
}
