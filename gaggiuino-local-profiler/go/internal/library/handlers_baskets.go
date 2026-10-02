package library

import (
	"errors"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file implements the basket endpoints (#635).

var basketWallTypes = map[string]bool{"pressurized": true, "single-wall": true, "precision-machined": true, "high-flow": true}
var basketShapes = map[string]bool{"straight": true, "tapered": true}

func findBasketIndex(lib Library, id int64) int {
	for i, b := range lib.Baskets {
		if bid, ok := idOf(b, "id"); ok && bid == id {
			return i
		}
	}
	return -1
}

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
	basket, _, err := CreateBasket(h.repo, body)
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
	basket, _, found, err := UpdateBasket(h.repo, id, body)
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
	id, noMatch := parseIDParam(r.PathValue("id"))
	var imgExt string
	// The image file removal below is filesystem I/O: it must not run while
	// Update holds the library write lock, so the closure only records the
	// extension and the handler deletes the file once Update returns.
	err := h.repo.Update(func(lib *Library) error {
		if !noMatch {
			if idx := findBasketIndex(*lib, id); idx != -1 {
				if ext, _ := lib.Baskets[idx]["image"].(string); ext != "" {
					imgExt = ext
				}
			}
		}
		filtered := make([]Entity, 0, len(lib.Baskets))
		removed := false
		for _, b := range lib.Baskets {
			bid, ok := idOf(b, "id")
			if !noMatch && ok && bid == id {
				removed = true
				continue
			}
			filtered = append(filtered, b)
		}
		if !removed {
			return ErrSkipSave
		}
		lib.Baskets = filtered
		return nil
	})
	if err != nil && !errors.Is(err, ErrSkipSave) {
		internalError(w, err)
		return
	}
	if imgExt != "" {
		img.Delete(h.imageDir, id, imgExt, "basket-")
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// getBasketImage handles GET /api/library/basket/:id/image.
func (h *Handlers) getBasketImage(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	ext := ""
	if !noMatch {
		if idx := findBasketIndex(lib, id); idx != -1 {
			ext, _ = lib.Baskets[idx]["image"].(string)
		}
	}
	h.serveImage(w, r, ext, "basket-", id)
}

// postBasketImage handles POST /api/library/basket/:id/image.
func (h *Handlers) postBasketImage(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitImage(w, r) {
		return
	}
	id, noMatch := parseIDParam(r.PathValue("id"))
	// Existence is decided before the upload is read/validated or any file is
	// written: an unknown id 404s even when the image is also invalid, and no
	// orphan file is ever written (matching dev's ordering).
	exists, err := h.entityExists(id, noMatch, findBasketIndex)
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
	ext, ok := img.Save(h.imageDir, "basket-", id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var basket Entity
	var oldExt string
	err = h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBasketIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		basket = lib.Baskets[idx]
		oldExt, _ = basket["image"].(string)
		basket["image"] = ext
		lib.Baskets[idx] = basket
		return nil
	})
	if err != nil {
		// The entity was deleted between the existence check and the write;
		// the just-saved file has no owner, so drop it.
		img.Delete(h.imageDir, id, ext, "basket-")
		writeUpdateError(w, err)
		return
	}
	if oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "basket-")
	}
	writeJSON(w, http.StatusOK, basket)
}
