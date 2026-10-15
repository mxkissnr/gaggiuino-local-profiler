package library

import (
	"errors"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file consolidates the per-entity image and delete handlers that beans,
// grinders, baskets, puck screens, milks and recipes each used to carry a copy
// of. A kind names one collection inside a Library plus, for the four kinds
// that carry a photo, the filename prefix naming its image files.

// entityKind describes one library collection: how to reach its slice inside a
// Library, and — for image-bearing kinds — hasImage/imagePrefix, the latter
// being img.Filename's prefix (beans use the empty prefix).
type entityKind struct {
	list        func(*Library) *[]Entity
	hasImage    bool
	imagePrefix string
}

var (
	beanKind       = entityKind{list: func(l *Library) *[]Entity { return &l.Beans }, hasImage: true, imagePrefix: ""}
	grinderKind    = entityKind{list: func(l *Library) *[]Entity { return &l.Grinders }, hasImage: true, imagePrefix: "grinder-"}
	basketKind     = entityKind{list: func(l *Library) *[]Entity { return &l.Baskets }, hasImage: true, imagePrefix: "basket-"}
	puckScreenKind = entityKind{list: func(l *Library) *[]Entity { return &l.PuckScreens }, hasImage: true, imagePrefix: "puckscreen-"}
	milkKind       = entityKind{list: func(l *Library) *[]Entity { return &l.Milks }}
	recipeKind     = entityKind{list: func(l *Library) *[]Entity { return &l.Recipes }}
)

// findEntityIndex returns the position of the entity whose "id" equals id in
// items, or -1 — the single loop the six former find<X>Index copies shared.
func findEntityIndex(items []Entity, id int64) int {
	for i, e := range items {
		if eid, ok := idOf(e, "id"); ok && eid == id {
			return i
		}
	}
	return -1
}

// getEntityImage handles the `GET .../image` route for one entity kind. 404s
// (via serveImage) when the entity or its image is missing.
func (h *Handlers) getEntityImage(w http.ResponseWriter, r *http.Request, k entityKind) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	ext := ""
	if !noMatch {
		if idx := findEntityIndex(*k.list(&lib), id); idx != -1 {
			ext, _ = (*k.list(&lib))[idx]["image"].(string)
		}
	}
	h.serveImage(w, r, ext, k.imagePrefix, id)
}

// postEntityImage handles the `POST .../image` route for one entity kind.
// respond writes the success response from the stored entity: beans enrich it
// (writeEnrichedBean), the others answer the bare entity.
//
// The ordering is part of the contract and must stay: rate limit -> parse id ->
// existence check before the upload is read/validated (see entityExists) ->
// read upload -> Save -> Update (404 if gone, then delete the just-saved
// file) -> delete the old file if the extension changed -> respond.
func (h *Handlers) postEntityImage(w http.ResponseWriter, r *http.Request, k entityKind, respond func(http.ResponseWriter, Entity)) {
	if !h.rateLimitImage(w, r) {
		return
	}
	id, noMatch := parseIDParam(r.PathValue("id"))
	// Existence is decided before the upload is read/validated or any file is
	// written: an unknown id 404s even when the image is also invalid, and no
	// orphan file is ever written (matching dev's ordering).
	exists, err := h.entityExists(id, noMatch, k)
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
	ext, ok := img.Save(h.imageDir, k.imagePrefix, id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var entity Entity
	var oldExt string
	err = h.repo.Update(func(lib *Library) error {
		items := k.list(lib)
		idx := -1
		if !noMatch {
			idx = findEntityIndex(*items, id)
		}
		if idx == -1 {
			return errNotFound
		}
		entity = (*items)[idx]
		oldExt, _ = entity["image"].(string)
		entity["image"] = ext
		(*items)[idx] = entity
		return nil
	})
	if err != nil {
		// The entity was deleted between the existence check and the write;
		// the just-saved file has no owner, so drop it.
		img.Delete(h.imageDir, id, ext, k.imagePrefix)
		writeUpdateError(w, err)
		return
	}
	if oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, k.imagePrefix)
	}
	respond(w, entity)
}

// deleteEntity handles the delete route shared by all six kinds. afterDelete
// is nil for every kind but grinders, which use it for their maintenance-row
// cleanup once the entity is gone.
func (h *Handlers) deleteEntity(w http.ResponseWriter, r *http.Request, k entityKind, afterDelete func(id int64)) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	var imgExt string
	// The image file removal below is filesystem I/O: it must not run while
	// Update holds the library write lock, so the closure only records the
	// extension and the handler deletes the file once Update returns.
	err := h.repo.Update(func(lib *Library) error {
		items := k.list(lib)
		if !noMatch && k.hasImage {
			if idx := findEntityIndex(*items, id); idx != -1 {
				if ext, _ := (*items)[idx]["image"].(string); ext != "" {
					imgExt = ext
				}
			}
		}
		filtered := make([]Entity, 0, len(*items))
		removed := false
		for _, e := range *items {
			eid, ok := idOf(e, "id")
			if !noMatch && ok && eid == id {
				removed = true
				continue
			}
			filtered = append(filtered, e)
		}
		if !removed {
			return ErrSkipSave
		}
		*items = filtered
		return nil
	})
	if err != nil && !errors.Is(err, ErrSkipSave) {
		internalError(w, err)
		return
	}
	if imgExt != "" {
		img.Delete(h.imageDir, id, imgExt, k.imagePrefix)
	}
	if afterDelete != nil {
		afterDelete(id)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// writeEntityJSON is the success response the image-bearing kinds other than
// beans use: the stored entity as-is.
func writeEntityJSON(w http.ResponseWriter, entity Entity) {
	writeJSON(w, http.StatusOK, entity)
}
