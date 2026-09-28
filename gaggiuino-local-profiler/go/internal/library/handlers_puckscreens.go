package library

import (
	"errors"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file ports routes/library/puckscreens.js (#635).

var puckScreenThicknesses = map[string]bool{"very-thin": true, "thin": true, "medium": true, "thick": true}

func findPuckScreenIndex(lib Library, id int64) int {
	for i, p := range lib.PuckScreens {
		if pid, ok := idOf(p, "id"); ok && pid == id {
			return i
		}
	}
	return -1
}

// listPuckScreens ports GET /api/library/puckscreens.
func (h *Handlers) listPuckScreens(w http.ResponseWriter, r *http.Request) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lib.PuckScreens)
}

// createPuckScreen ports POST /api/library/puckscreen — a thin wrapper
// around CreatePuckScreen (create.go), the same logic internal/web's "New
// puck screen" form also calls.
func (h *Handlers) createPuckScreen(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	puckScreen, _, err := CreatePuckScreen(h.repo, body)
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

// updatePuckScreen ports PUT /api/library/puckscreen/:id — a thin wrapper
// around UpdatePuckScreen (update.go), the same logic internal/web's Edit
// puck screen form also calls.
func (h *Handlers) updatePuckScreen(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	puckScreen, _, found, err := UpdatePuckScreen(h.repo, id, body)
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

// deletePuckScreen ports DELETE /api/library/puckscreen/:id.
func (h *Handlers) deletePuckScreen(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	var imgExt string
	// The image file removal below is filesystem I/O: it must not run while
	// Update holds the library write lock, so the closure only records the
	// extension and the handler deletes the file once Update returns.
	err := h.repo.Update(func(lib *Library) error {
		if !noMatch {
			if idx := findPuckScreenIndex(*lib, id); idx != -1 {
				if ext, _ := lib.PuckScreens[idx]["image"].(string); ext != "" {
					imgExt = ext
				}
			}
		}
		filtered := make([]Entity, 0, len(lib.PuckScreens))
		removed := false
		for _, p := range lib.PuckScreens {
			pid, ok := idOf(p, "id")
			if !noMatch && ok && pid == id {
				removed = true
				continue
			}
			filtered = append(filtered, p)
		}
		if !removed {
			return ErrSkipSave
		}
		lib.PuckScreens = filtered
		return nil
	})
	if err != nil && !errors.Is(err, ErrSkipSave) {
		internalError(w, err)
		return
	}
	if imgExt != "" {
		img.Delete(h.imageDir, id, imgExt, "puckscreen-")
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// getPuckScreenImage ports GET /api/library/puckscreen/:id/image.
func (h *Handlers) getPuckScreenImage(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	ext := ""
	if !noMatch {
		if idx := findPuckScreenIndex(lib, id); idx != -1 {
			ext, _ = lib.PuckScreens[idx]["image"].(string)
		}
	}
	h.serveImage(w, r, ext, "puckscreen-", id)
}

// postPuckScreenImage ports POST /api/library/puckscreen/:id/image.
func (h *Handlers) postPuckScreenImage(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitImage(w, r) {
		return
	}
	id, noMatch := parseIDParam(r.PathValue("id"))
	data, contentType, ok := readUploadedImage(w, r)
	if !ok {
		return
	}
	ext, ok := img.Save(h.imageDir, "puckscreen-", id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var puckScreen Entity
	var oldExt string
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findPuckScreenIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		puckScreen = lib.PuckScreens[idx]
		oldExt, _ = puckScreen["image"].(string)
		puckScreen["image"] = ext
		lib.PuckScreens[idx] = puckScreen
		return nil
	})
	if err != nil {
		// The image file was written before the entity lookup; nothing
		// references it if the write failed, so drop it (the pre-Update code
		// never wrote it at all).
		img.Delete(h.imageDir, id, ext, "puckscreen-")
		writeUpdateError(w, err)
		return
	}
	if oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "puckscreen-")
	}
	writeJSON(w, http.StatusOK, puckScreen)
}
