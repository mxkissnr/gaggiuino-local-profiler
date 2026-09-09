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

// resetBurrs ports POST /api/library/grinder/:id/reset-burrs.
func (h *Handlers) resetBurrs(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findGrinderIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	grinder := lib.Grinders[idx]
	grinder["burrsResetAt"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	lib.Grinders[idx] = grinder
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
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
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	if !noMatch {
		if idx := findGrinderIndex(lib, id); idx != -1 {
			if ext, _ := lib.Grinders[idx]["image"].(string); ext != "" {
				img.Delete(h.imageDir, id, ext, "grinder-")
			}
		}
	}
	filtered := make([]Entity, 0, len(lib.Grinders))
	for _, g := range lib.Grinders {
		gid, ok := idOf(g, "id")
		if !noMatch && ok && gid == id {
			continue
		}
		filtered = append(filtered, g)
	}
	lib.Grinders = filtered
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
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
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findGrinderIndex(lib, id)
	}
	if idx == -1 {
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
	grinder := lib.Grinders[idx]
	if oldExt, _ := grinder["image"].(string); oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "grinder-")
	}
	grinder["image"] = ext
	lib.Grinders[idx] = grinder
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, grinder)
}
