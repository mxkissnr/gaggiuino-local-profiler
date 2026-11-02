package library

import (
	"errors"
	"net/http"
	"net/url"
	"os"

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
// (via serveImage) when the entity or its image is missing. An entity with a
// stored `imageCrop` also has an uncropped original, which `?original=1`
// serves.
func (h *Handlers) getEntityImage(w http.ResponseWriter, r *http.Request, k entityKind) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	ext := ""
	hasCrop := false
	if !noMatch {
		if idx := findEntityIndex(*k.list(&lib), id); idx != -1 {
			entity := (*k.list(&lib))[idx]
			ext, _ = entity["image"].(string)
			_, hasCrop = entityCrop(entity)
		}
	}
	h.serveImage(w, r, ext, k.imagePrefix, id, hasCrop)
}

// entityCrop reads an entity's stored `imageCrop` rectangle. It reports false
// unless the stored object is a complete, valid crop — a malformed stored
// value degrades to "no crop", never to a panic or a bogus rectangle.
func entityCrop(entity Entity) (img.Crop, bool) {
	raw, ok := entity["imageCrop"].(map[string]any)
	if !ok {
		return img.Crop{}, false
	}
	values := make([]float64, 4)
	for i, key := range []string{"x", "y", "w", "h"} {
		v, ok := jsParseFloat(raw[key])
		if !ok {
			return img.Crop{}, false
		}
		values[i] = v
	}
	c := img.Crop{X: values[0], Y: values[1], W: values[2], H: values[3]}
	if !c.Valid() {
		return img.Crop{}, false
	}
	return c, true
}

// cropEntity is the stored shape of img.Crop on a library entity.
func cropEntity(c img.Crop) Entity {
	return Entity{"x": c.X, "y": c.Y, "w": c.W, "h": c.H}
}

// parseCropParam parses a `crop=x,y,w,h` query value, reporting false for
// both a malformed and an out-of-range rectangle.
func parseCropParam(raw string) (img.Crop, bool) {
	c, err := img.ParseCrop(raw)
	if err != nil || !c.Valid() {
		return img.Crop{}, false
	}
	return c, true
}

// postEntityImage handles the `POST .../image` route for one entity kind.
// respond writes the success response from the stored entity: beans enrich it
// (writeEnrichedBean), the others answer the bare entity.
//
// The ordering is part of the contract and must stay: rate limit -> parse id ->
// existence check before the upload is read/validated (see entityFor) ->
// dispatch on the query -> read upload -> Save -> Update (404 if gone, then
// delete the just-saved file) -> delete the old file if the extension changed
// -> respond.
//
// The query selects one of three variants; anything else is a 400:
//   - none: a new photo, which also drops any previous original and crop.
//   - crop=x,y,w,h: re-crop the stored original, body ignored.
//   - original=1&crop=x,y,w,h: keep this upload as the uncropped original of
//     the current photo; the main image is untouched.
func (h *Handlers) postEntityImage(w http.ResponseWriter, r *http.Request, k entityKind, respond func(http.ResponseWriter, Entity)) {
	if !h.rateLimitImage(w, r) {
		return
	}
	id, noMatch := parseIDParam(r.PathValue("id"))
	// Existence is decided before the upload is read/validated or any file is
	// written: an unknown id 404s even when the image is also invalid, and no
	// orphan file is ever written (matching dev's ordering).
	entity, exists, err := h.entityFor(id, noMatch, k)
	if err != nil {
		internalError(w, err)
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	q := r.URL.Query()
	if !validImageQuery(q) {
		writeError(w, http.StatusBadRequest, "invalid image request")
		return
	}
	// validImageQuery has already rejected a repeated `crop`, so Get returns
	// the single value.
	_, hasCrop := q["crop"]
	wantOriginal := q.Get("original") == "1"
	switch {
	case wantOriginal && hasCrop:
		h.storeEntityOriginal(w, r, id, entity, k, respond, q.Get("crop"))
	case wantOriginal:
		writeError(w, http.StatusBadRequest, "invalid crop")
	case hasCrop:
		h.recropEntityImage(w, id, k, respond, q.Get("crop"))
	default:
		h.replaceEntityImage(w, r, id, noMatch, k, respond)
	}
}

// validImageQuery reports whether the query is one of the three supported
// image-request shapes: no parameters, `crop` alone, or `original=1` with
// `crop`. `original` must be exactly "1" — the value the GET route treats as
// "serve the original".
func validImageQuery(q url.Values) bool {
	for name, values := range q {
		switch name {
		case "crop":
			if len(values) != 1 {
				return false
			}
		case "original":
			if len(values) != 1 || values[0] != "1" {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// replaceEntityImage stores a newly uploaded photo as the main image, dropping
// the previous crop and the previous uncropped original (both describe the
// picture being replaced).
func (h *Handlers) replaceEntityImage(w http.ResponseWriter, r *http.Request, id int64, noMatch bool, k entityKind, respond func(http.ResponseWriter, Entity)) {
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
	err := h.repo.Update(func(lib *Library) error {
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
		delete(entity, "imageCrop")
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
	img.DeleteOriginal(h.imageDir, id, k.imagePrefix)
	respond(w, entity)
}

// recropEntityImage rebuilds the main image from the stored uncropped
// original. The upload body is ignored: a re-crop is a pure server-side
// operation on bytes that are already on disk.
func (h *Handlers) recropEntityImage(w http.ResponseWriter, id int64, k entityKind, respond func(http.ResponseWriter, Entity), raw string) {
	crop, ok := parseCropParam(raw)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid crop")
		return
	}
	original, err := img.ReadOriginal(h.imageDir, k.imagePrefix, id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusConflict, "no original")
			return
		}
		internalError(w, err)
		return
	}
	data, err := img.CropJPEG(original, crop)
	if err != nil {
		internalError(w, err)
		return
	}
	ext, ok := img.Save(h.imageDir, k.imagePrefix, id, data, "image/jpeg", img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var entity Entity
	var oldExt string
	err = h.repo.Update(func(lib *Library) error {
		items := k.list(lib)
		idx := findEntityIndex(*items, id)
		if idx == -1 {
			return errNotFound
		}
		entity = (*items)[idx]
		oldExt, _ = entity["image"].(string)
		entity["image"] = ext
		entity["imageCrop"] = cropEntity(crop)
		(*items)[idx] = entity
		return nil
	})
	if err != nil {
		// The entity vanished between the read and the write. Drop the fresh
		// main image only: the stored original still belongs to it if it comes
		// back (e.g. a concurrent restore), and DeleteMain leaves it alone.
		img.DeleteMain(h.imageDir, id, ext, k.imagePrefix)
		writeUpdateError(w, err)
		return
	}
	if oldExt != "" && oldExt != ext {
		// DeleteMain, never Delete: the original is what future re-crops read.
		img.DeleteMain(h.imageDir, id, oldExt, k.imagePrefix)
	}
	respond(w, entity)
}

// storeEntityOriginal keeps an upload as the uncropped original of the
// entity's current photo and records the crop that produced that photo. The
// main image is untouched.
func (h *Handlers) storeEntityOriginal(w http.ResponseWriter, r *http.Request, id int64, entity Entity, k entityKind, respond func(http.ResponseWriter, Entity), raw string) {
	crop, ok := parseCropParam(raw)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid crop")
		return
	}
	if ext, _ := entity["image"].(string); ext == "" {
		writeError(w, http.StatusConflict, "no image")
		return
	}
	data, _, ok := readUploadedImage(w, r)
	if !ok {
		return
	}
	if err := img.WriteOriginal(h.imageDir, k.imagePrefix, id, data); err != nil {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var updated Entity
	err := h.repo.Update(func(lib *Library) error {
		items := k.list(lib)
		idx := findEntityIndex(*items, id)
		if idx == -1 {
			return errNotFound
		}
		updated = (*items)[idx]
		updated["imageCrop"] = cropEntity(crop)
		(*items)[idx] = updated
		return nil
	})
	if err != nil {
		// No entity to own the original we just wrote.
		img.DeleteOriginal(h.imageDir, id, k.imagePrefix)
		writeUpdateError(w, err)
		return
	}
	respond(w, updated)
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
