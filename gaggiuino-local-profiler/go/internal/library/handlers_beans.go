package library

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file ports routes/library/beans.js.

func findBeanIndex(lib Library, id int64) int {
	for i, b := range lib.Beans {
		if bid, ok := idOf(b, "id"); ok && bid == id {
			return i
		}
	}
	return -1
}

// createBean ports POST /api/library/bean — a thin wrapper around
// CreateBean (create.go), the same read-validate-save logic internal/web's
// "New bean" form also calls.
func (h *Handlers) createBean(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitCreate(w, r) {
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	bean, _, err := CreateBean(h.repo, h.imageDir, body)
	if err != nil {
		var verr *ValidationError
		if errors.As(err, &verr) {
			writeError(w, http.StatusBadRequest, verr.Message)
			return
		}
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// updateBean ports PUT /api/library/bean/:id — a thin wrapper around
// UpdateBean (update.go), the same partial-update logic internal/web's Edit
// bean form also calls. Partial update: omitted fields keep their current
// value.
func (h *Handlers) updateBean(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	bean, _, found, err := UpdateBean(h.repo, id, body)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// newBag ports POST /api/library/bean/:id/new-bag.
func (h *Handlers) newBag(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findBeanIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bean := lib.Beans[idx]
	roastDate := trimMax(body["roastDate"], 10)
	stockG := floatOrNilFalsy(body["stock_g"])
	batchNumber := trimMax(body["batchNumber"], 50)

	bag := Entity{"id": newID(), "roastDate": roastDate, "stock_g": stockG, "openedAt": newID(), "batchNumber": batchNumber}
	bags := bagsOf(bean)
	bean["bags"] = append(bags, bag)
	bean["roastDate"] = roastDate
	bean["stock_g"] = stockG
	lib.Beans[idx] = bean

	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// freezePortions ports POST /api/library/bean/:id/freeze-portions (#472).
func (h *Handlers) freezePortions(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findBeanIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bean := lib.Beans[idx]
	bags := bagsOf(bean)
	if len(bags) == 0 {
		writeError(w, http.StatusBadRequest, "no active bag")
		return
	}
	// `Number.isFinite(req.body?.frozenAt) ? ... : Date.now()` — strictly a
	// JSON number, not a numeric string (unlike jsParseFloat elsewhere).
	frozenAt, isNum := body["frozenAt"].(float64)
	if !isNum || math.IsInf(frozenAt, 0) {
		frozenAt = float64(newID())
	}
	candidate := Entity{"frozenAt": frozenAt, "portionCount": body["portionCount"], "portionWeight_g": body["portionWeight_g"]}
	portions := sanitizeFrozenPortions([]any{candidate})
	if len(portions) == 0 {
		writeError(w, http.StatusBadRequest, "portionCount and portionWeight_g required")
		return
	}
	newPortion := portions[0]

	last, _ := bags[len(bags)-1].(Entity)
	fp, _ := last["frozenPortions"].([]any)
	last["frozenPortions"] = append(fp, newPortion)
	lib.Beans[idx] = bean

	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// findFrozenPortion locates a frozen portion by id across every bag,
// mirroring the JS `for (const bag of bags) { portion = ...find(...); if
// (portion) break; }` loop shared by thaw-portion/adjust-frozen-portion.
func findFrozenPortion(bean Entity, portionID int64, requireNotThawed bool) Entity {
	for _, b := range bagsOf(bean) {
		bag, _ := b.(Entity)
		if bag == nil {
			continue
		}
		fps, _ := bag["frozenPortions"].([]any)
		for _, p := range fps {
			portion, _ := p.(Entity)
			if portion == nil {
				continue
			}
			pid, ok := idOf(portion, "id")
			if !ok || pid != portionID {
				continue
			}
			if requireNotThawed {
				if _, thawed := portion["thawedAt"]; thawed {
					continue
				}
			}
			return portion
		}
	}
	return nil
}

// thawPortion ports POST /api/library/bean/:id/thaw-portion (#472).
func (h *Handlers) thawPortion(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findBeanIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bean := lib.Beans[idx]
	portionID, _ := jsParseIntLoose(body["portionId"])
	count := int64(1)
	if c, ok := jsParseIntLoose(body["count"]); ok && c > 0 {
		count = c
	}
	portion := findFrozenPortion(bean, portionID, true)
	if portion == nil {
		writeError(w, http.StatusNotFound, "frozen portion not found")
		return
	}
	currentRemaining, ok := jsParseIntLoose(portion["remainingCount"])
	if !ok {
		currentRemaining, _ = jsParseIntLoose(portion["portionCount"])
	}
	remaining := currentRemaining - count
	if remaining < 0 {
		remaining = 0
	}
	portion["remainingCount"] = remaining
	if remaining == 0 {
		portion["thawedAt"] = newID()
	}
	lib.Beans[idx] = bean
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// adjustFrozenPortion ports POST /api/library/bean/:id/adjust-frozen-portion (#472).
func (h *Handlers) adjustFrozenPortion(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findBeanIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bean := lib.Beans[idx]
	portionID, _ := jsParseIntLoose(body["portionId"])
	portion := findFrozenPortion(bean, portionID, false)
	if portion == nil {
		writeError(w, http.StatusNotFound, "frozen portion not found")
		return
	}

	if v, present := body["portionWeight_g"]; present && v != nil {
		wgt, ok := jsParseFloat(v)
		if !ok || !(wgt > 0 && wgt <= 2000) {
			writeError(w, http.StatusBadRequest, "invalid portionWeight_g")
			return
		}
		portion["portionWeight_g"] = roundTo1(wgt)
	}
	if v, present := body["frozenAt"]; present && v != nil {
		fa, ok := v.(float64)
		if !ok || math.IsInf(fa, 0) {
			writeError(w, http.StatusBadRequest, "invalid frozenAt")
			return
		}
		portion["frozenAt"] = fa
	}
	if v, present := body["remainingCount"]; present && v != nil {
		rc, ok := jsParseIntLoose(v)
		if !ok || rc < 0 {
			writeError(w, http.StatusBadRequest, "invalid remainingCount")
			return
		}
		portionCount, _ := jsParseIntLoose(portion["portionCount"])
		if rc > portionCount {
			rc = portionCount
		}
		portion["remainingCount"] = rc
		if rc == 0 {
			if _, already := portion["thawedAt"]; !already {
				portion["thawedAt"] = newID()
			}
		} else {
			delete(portion, "thawedAt")
		}
	}

	lib.Beans[idx] = bean
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// deleteBag ports DELETE /api/library/bean/:id/bag/:bagId.
func (h *Handlers) deleteBag(w http.ResponseWriter, r *http.Request) {
	id, idNoMatch := parseIDParam(r.PathValue("id"))
	bagID, bagNoMatch := parseIDParam(r.PathValue("bagId"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !idNoMatch {
		idx = findBeanIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bean := lib.Beans[idx]
	bags := bagsOf(bean)
	if len(bags) <= 1 {
		writeError(w, http.StatusBadRequest, "cannot delete last bag")
		return
	}
	filtered := make([]any, 0, len(bags))
	for _, b := range bags {
		bag, _ := b.(Entity)
		bgID, ok := idOf(bag, "id")
		if !bagNoMatch && ok && bgID == bagID {
			continue
		}
		filtered = append(filtered, b)
	}
	bean["bags"] = filtered
	last, _ := filtered[len(filtered)-1].(Entity)
	bean["roastDate"] = last["roastDate"]
	bean["stock_g"] = last["stock_g"]
	lib.Beans[idx] = bean

	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// deleteBean ports POST /api/library/bean/:id/delete.
func (h *Handlers) deleteBean(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	if !noMatch {
		if idx := findBeanIndex(lib, id); idx != -1 {
			if ext, _ := lib.Beans[idx]["image"].(string); ext != "" {
				img.Delete(h.imageDir, id, ext, "")
			}
		}
	}
	filtered := make([]Entity, 0, len(lib.Beans))
	for _, b := range lib.Beans {
		bid, ok := idOf(b, "id")
		if !noMatch && ok && bid == id {
			continue
		}
		filtered = append(filtered, b)
	}
	lib.Beans = filtered
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// toggleBeanActive ports POST /api/library/bean/:id/toggle-active (#578).
//
// id is parsed but NOT validated before calling ToggleBeanActive — passing
// through a noMatch id (0, matching no real bean) rather than
// short-circuiting to 404 here keeps the original pre-#901 ordering: a
// request always reaches the DB (ToggleBeanActive's own GetLibrary) before
// "not found" is decided, so a broken/unreachable DB still surfaces as 500
// even when the path's {id} also happens to be malformed, instead of a
// malformed id masking a DB outage behind a false-negative 404.
func (h *Handlers) toggleBeanActive(w http.ResponseWriter, r *http.Request) {
	id, _ := parseIDParam(r.PathValue("id"))
	bean, _, found, err := ToggleBeanActive(h.repo, id)
	if err != nil {
		internalError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// knownGrind ports POST /api/library/bean/:id/known-grind (#310).
func (h *Handlers) knownGrind(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	grinderTrimmed := trimMax(body["grinder"], 200)
	if grinderTrimmed == "" {
		writeError(w, http.StatusBadRequest, "grinder required")
		return
	}
	gs, present := body["grindSetting"]
	if !present || gs == nil || gs == "" {
		writeError(w, http.StatusBadRequest, "grindSetting required")
		return
	}
	grindSetting := grindSettingString(gs)

	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	if noMatch {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bean, found := UpsertKnownGrindSetting(&lib, id, grinderTrimmed, grindSetting)
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}

// grindSettingString ports `String(grindSetting).trim().slice(0, 50)` —
// grindSetting is typically a number (a "22" grinder click count) or a
// string, and JS's String() coerces either.
func grindSettingString(v any) string {
	switch t := v.(type) {
	case string:
		return truncateUTF8(strings.TrimSpace(t), 50)
	case float64:
		return truncateUTF8(formatJSNumber(t), 50)
	default:
		return ""
	}
}

// formatJSNumber ports JS's String(number): an integral value prints
// without a trailing ".0" (String(22) === "22"), matching what
// grindSetting values (grinder click counts) realistically are.
func formatJSNumber(f float64) string {
	if f == math.Trunc(f) && !math.IsInf(f, 0) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// getBeanImage ports GET /api/library/bean/:id/image.
func (h *Handlers) getBeanImage(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	ext := ""
	if !noMatch {
		if idx := findBeanIndex(lib, id); idx != -1 {
			ext, _ = lib.Beans[idx]["image"].(string)
		}
	}
	h.serveImage(w, r, ext, "", id)
}

// postBeanImage ports POST /api/library/bean/:id/image (manual upload
// fallback — no URL fetch, no SSRF surface, unlike bean creation's
// imageUrl field).
func (h *Handlers) postBeanImage(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	idx := -1
	if !noMatch {
		idx = findBeanIndex(lib, id)
	}
	if idx == -1 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	data, contentType, ok := readUploadedImage(w, r)
	if !ok {
		return
	}
	ext, ok := img.Save(h.imageDir, "", id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	bean := lib.Beans[idx]
	if oldExt, _ := bean["image"].(string); oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "")
	}
	bean["image"] = ext
	lib.Beans[idx] = bean
	if err := h.repo.SaveLibrary(lib); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bean)
}
