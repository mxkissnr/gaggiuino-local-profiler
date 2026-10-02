package library

import (
	"errors"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file implements the bean endpoints.

func findBeanIndex(lib Library, id int64) int {
	for i, b := range lib.Beans {
		if bid, ok := idOf(b, "id"); ok && bid == id {
			return i
		}
	}
	return -1
}

// createBean handles POST /api/library/bean — a thin wrapper around
// CreateBean (create.go).
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
	h.writeEnrichedBean(w, bean)
}

// updateBean handles PUT /api/library/bean/:id — a thin wrapper around
// UpdateBean (update.go). Partial update: omitted fields keep their current
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
	h.writeEnrichedBean(w, bean)
}

// newBag handles POST /api/library/bean/:id/new-bag.
func (h *Handlers) newBag(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	// Read the dose rows before the write so newBag can tell whether the bean
	// was already empty when the new bag lands — the restock achievement's
	// "wasEmpty" moment (#1286 R2). Best-effort: a failure here must not fail
	// an otherwise valid new-bag request; it just leaves wasEmpty false.
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		log.Printf("library: reading doses for restock check: %v", err)
	}
	var bean Entity
	var wasEmpty bool
	err = h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		// Same definition of "no remaining stock" as ComputeBeanRemaining
		// exposes as the bean's remainingG (and the bean_empty badge reads):
		// present and non-positive, before the new bag is appended below.
		if rem, present := ComputeBeanRemaining(bean, doseRows, lib.Beans); present && rem <= 0 {
			wasEmpty = true
		}
		roastDate := trimMax(body["roastDate"], 10)
		stockG := floatOrNilFalsy(body["stock_g"])
		batchNumber := trimMax(body["batchNumber"], 50)
		priceEur, ok := validateBagFloatField(body, "price_eur")
		if !ok {
			return &apiError{http.StatusBadRequest, "invalid price_eur"}
		}
		bags := bagsOf(bean)
		// New bag always joins the back of the queue (highest sortOrder + 1) —
		// it does NOT become current just by existing; SimulateBagQueue only
		// promotes it once every bag ahead of it in the queue is exhausted.
		var nextSort int64
		for _, raw := range bags {
			if bg, ok := raw.(Entity); ok {
				nextSort = maxInt64(nextSort, effectiveSortOrder(bg)+1)
			}
		}
		bagID := newID()
		bag := Entity{"id": bagID, "roastDate": roastDate, "stock_g": stockG, "openedAt": newID(), "batchNumber": batchNumber, "price_eur": priceEur, "sortOrder": nextSort}
		bean["bags"] = append(bags, bag)
		// Sync bean-level fields only when this new bag is the one
		// SimulateBagQueue actually considers current (i.e. every other bag
		// was already exhausted, so this one is drawn from immediately) — not
		// unconditionally, which would overwrite the bean's displayed roast
		// date/stock with a bag still queued behind the real current one.
		if cur := resolveCurrentBagSimple(bean); cur != nil {
			if cid, ok := idOf(cur, "id"); ok && cid == bagID {
				bean["roastDate"] = bag["roastDate"]
				bean["stock_g"] = bag["stock_g"]
			}
		}
		lib.Beans[idx] = bean
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.notifyBeanRestocked(wasEmpty)
	h.writeEnrichedBean(w, bean)
}

// reorderBags handles POST /api/library/bean/:id/reorder-bags: the client
// sends the desired bag ID order for its "upcoming" queue (never including
// the current or past bags — see the web UI's swapless drag reorder), and
// this assigns sequential sortOrder values in one atomic write, replacing
// what would otherwise be N sequential PUTs from the client.
func (h *Handlers) reorderBags(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	rawIDs, _ := body["bagIds"].([]any)
	if len(rawIDs) == 0 {
		writeError(w, http.StatusBadRequest, "bagIds required")
		return
	}
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		bags := bagsOf(bean)
		byID := make(map[int64]Entity, len(bags))
		for _, raw := range bags {
			if bg, ok := raw.(Entity); ok {
				if bid, ok := idOf(bg, "id"); ok {
					byID[bid] = bg
				}
			}
		}
		// Reassigned sortOrder values must stay strictly above the current
		// bag's — otherwise reordering the upcoming queue could accidentally
		// sort one of them ahead of the bag actually being drawn from right
		// now (see SimulateBagQueue: queue order is global, not scoped to
		// "upcoming"). Past/exhausted bags are unaffected either way since a
		// bag with 0 capacity left never advances the queue regardless of its
		// position.
		baseline := int64(0)
		currentBagID := int64(-1)
		if cur := resolveCurrentBagSimple(bean); cur != nil {
			baseline = effectiveSortOrder(cur)
			if cid, ok := idOf(cur, "id"); ok {
				currentBagID = cid
			}
		}
		// bagIds must be exactly the set of "upcoming" (non-current) bags —
		// no duplicates, none missing. Assigning sortOrder to only a subset
		// would leave the omitted bags' old values unchanged, which can now
		// collide with or fall between the freshly-assigned ones (the new
		// values are baseline+1, baseline+2, ... contiguous integers, so any
		// stale value in that range is no longer guaranteed unique); a
		// duplicate id in the request would just assign it a sortOrder twice,
		// silently discarding whichever assignment came first.
		upcoming := make(map[int64]bool, len(bags))
		for bid := range byID {
			if bid != currentBagID {
				upcoming[bid] = true
			}
		}
		seen := make(map[int64]bool, len(rawIDs))
		for _, rawID := range rawIDs {
			bagID, ok := jsParseIntLoose(rawID)
			if !ok {
				return &apiError{http.StatusBadRequest, "invalid bagId in bagIds"}
			}
			if _, found := byID[bagID]; !found {
				return &apiError{http.StatusBadRequest, "unknown bagId in bagIds"}
			}
			if bagID == currentBagID {
				return &apiError{http.StatusBadRequest, "bagIds must not include the current bag"}
			}
			if seen[bagID] {
				return &apiError{http.StatusBadRequest, "duplicate bagId in bagIds"}
			}
			seen[bagID] = true
		}
		if len(seen) != len(upcoming) {
			return &apiError{http.StatusBadRequest, "bagIds must list every upcoming bag exactly once"}
		}
		for i, rawID := range rawIDs {
			bagID, _ := jsParseIntLoose(rawID)
			byID[bagID]["sortOrder"] = baseline + int64(i+1)
		}
		lib.Beans[idx] = bean
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// freezePortions handles POST /api/library/bean/:id/freeze-portions (#472).
func (h *Handlers) freezePortions(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		bags := bagsOf(bean)
		if len(bags) == 0 {
			return errNoActiveBag
		}
		// frozenAt must be strictly a JSON number, not a numeric string (unlike
		// jsParseFloat elsewhere).
		frozenAt, isNum := body["frozenAt"].(float64)
		if !isNum || math.IsInf(frozenAt, 0) {
			frozenAt = float64(newID())
		}
		candidate := Entity{"frozenAt": frozenAt, "portionCount": body["portionCount"], "portionWeight_g": body["portionWeight_g"]}
		portions := sanitizeFrozenPortions([]any{candidate})
		if len(portions) == 0 {
			return errPortionFieldsRequired
		}
		newPortion := portions[0]

		// Attach to the queue's current bag — the one actually being drawn
		// from — not the array-last bag (see #sortOrder rework; those can now
		// differ once bags are manually reordered).
		target := resolveCurrentBagSimple(bean)
		if target == nil {
			target, _ = bags[len(bags)-1].(Entity)
		}
		fp, _ := target["frozenPortions"].([]any)
		target["frozenPortions"] = append(fp, newPortion)
		lib.Beans[idx] = bean
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// findFrozenPortion locates a frozen portion by id across every bag. The
// same search backs both thaw-portion and adjust-frozen-portion.
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

// thawPortion handles POST /api/library/bean/:id/thaw-portion (#472).
func (h *Handlers) thawPortion(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		portionID, _ := jsParseIntLoose(body["portionId"])
		count := int64(1)
		if c, ok := jsParseIntLoose(body["count"]); ok && c > 0 {
			count = c
		}
		portion := findFrozenPortion(bean, portionID, true)
		if portion == nil {
			return errFrozenPortionNotFound
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
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// adjustFrozenPortion handles POST /api/library/bean/:id/adjust-frozen-portion (#472).
func (h *Handlers) adjustFrozenPortion(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		portionID, _ := jsParseIntLoose(body["portionId"])
		portion := findFrozenPortion(bean, portionID, false)
		if portion == nil {
			return errFrozenPortionNotFound
		}

		if v, present := body["portionWeight_g"]; present && v != nil {
			wgt, ok := jsParseFloat(v)
			if !ok || !(wgt > 0 && wgt <= 2000) {
				return errInvalidPortionWeight
			}
			portion["portionWeight_g"] = roundTo1(wgt)
		}
		if v, present := body["frozenAt"]; present && v != nil {
			fa, ok := v.(float64)
			if !ok || math.IsInf(fa, 0) {
				return errInvalidFrozenAt
			}
			portion["frozenAt"] = fa
		}
		if v, present := body["remainingCount"]; present && v != nil {
			rc, ok := jsParseIntLoose(v)
			if !ok || rc < 0 {
				return errInvalidRemainingCount
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
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// deleteBag handles DELETE /api/library/bean/:id/bag/:bagId.
func (h *Handlers) deleteBag(w http.ResponseWriter, r *http.Request) {
	id, idNoMatch := parseIDParam(r.PathValue("id"))
	bagID, bagNoMatch := parseIDParam(r.PathValue("bagId"))
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !idNoMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		bags := bagsOf(bean)
		if len(bags) <= 1 {
			return errCannotDeleteLastBag
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
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// validateBagFloatField parses body[key] with the same parseFloat-or-null
// idiom as floatOrNilFalsy, but — unlike bean-level price_eur's
// sanitizePrice, which silently clamps an out-of-range/unparseable value to
// nil — treats a present-but-non-numeric or negative value as a hard 400.
// Bag stock_g/price_eur are only ever set by the app's own numeric inputs,
// so a value that fails to parse here means a client bug, not a legitimate
// free-text omission the way a roaster-entered bean price can be.
func validateBagFloatField(body Entity, key string) (any, bool) {
	v, present := body[key]
	if !present || v == nil {
		return nil, true
	}
	f, ok := jsParseFloat(v)
	if !ok || f < 0 {
		return nil, false
	}
	return f, true
}

// validateBagRoastDate implements the updateBag roastDate gate: a date
// parseable as YYYY-MM-DD that's more than a day in the future almost
// certainly means a client clock/timezone bug rather than an intentional
// future roast date, so it's rejected outright — unlike bean-level roastDate
// (trimMax), which never validates the string's content, just its length.
func validateBagRoastDate(body Entity) (string, bool) {
	roastDate := trimMax(body["roastDate"], 10)
	if roastDate == "" {
		return roastDate, true
	}
	parsed, err := time.Parse("2006-01-02", roastDate)
	if err != nil {
		return roastDate, true
	}
	if parsed.After(time.Now().AddDate(0, 0, 1)) {
		return roastDate, false
	}
	return roastDate, true
}

// updateBag handles PUT /api/library/bean/{id}/bag/{bagId}: edit any bag's
// mutable fields (roastDate, stock_g, batchNumber, price_eur). If the updated
// bag is the active (last) bag, bean-level roastDate and stock_g are synced.
func (h *Handlers) updateBag(w http.ResponseWriter, r *http.Request) {
	id, idNoMatch := parseIDParam(r.PathValue("id"))
	bagID, bagNoMatch := parseIDParam(r.PathValue("bagId"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !idNoMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		bags := bagsOf(bean)
		bagIdx := -1
		if !bagNoMatch {
			for i, raw := range bags {
				bag, ok := raw.(Entity)
				if !ok {
					continue
				}
				if bid, ok := idOf(bag, "id"); ok && bid == bagID {
					bagIdx = i
					break
				}
			}
		}
		if bagIdx == -1 {
			return &apiError{http.StatusNotFound, "bag not found"}
		}
		roastDate, ok := validateBagRoastDate(body)
		if !ok {
			return &apiError{http.StatusBadRequest, "roastDate cannot be in the future"}
		}
		stockG, ok := validateBagFloatField(body, "stock_g")
		if !ok {
			return &apiError{http.StatusBadRequest, "invalid stock_g"}
		}
		priceEur, ok := validateBagFloatField(body, "price_eur")
		if !ok {
			return &apiError{http.StatusBadRequest, "invalid price_eur"}
		}
		bag := bags[bagIdx].(Entity)
		// sortOrder, unlike every other field here, is genuinely optional per
		// request (the reorder-bags endpoint is the normal way to change it in
		// bulk; most PUTs here — stock-adjust, mark-empty, the edit dialog —
		// never touch it) — falling back to the bag's current value instead of
		// full-replacing it like roastDate/stock_g/price_eur do keeps a plain
		// "resend everything but sortOrder" caller from silently resetting the
		// bag's queue position.
		sortOrder, sortOK := jsParseIntLoose(body["sortOrder"])
		if !sortOK {
			sortOrder = effectiveSortOrder(bag)
		}
		bag["roastDate"] = roastDate
		bag["stock_g"] = stockG
		bag["batchNumber"] = trimMax(body["batchNumber"], 50)
		bag["price_eur"] = priceEur
		bag["sortOrder"] = sortOrder
		bags[bagIdx] = bag
		bean["bags"] = bags
		// Sync bean-level fields only when the edited bag is the one SimulateBagQueue
		// considers current — not the array-last bag, which differs after reorderBags.
		if cur := resolveCurrentBagSimple(bean); cur != nil {
			if cid, ok := idOf(cur, "id"); ok && cid == bagID {
				bean["roastDate"] = bag["roastDate"]
				bean["stock_g"] = bag["stock_g"]
			}
		}
		lib.Beans[idx] = bean
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// deleteBean handles POST /api/library/bean/:id/delete.
func (h *Handlers) deleteBean(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	var imgExt string
	// The image file removal below is filesystem I/O: it must not run while
	// Update holds the library write lock, so the closure only records the
	// extension and the handler deletes the file once Update returns.
	err := h.repo.Update(func(lib *Library) error {
		if !noMatch {
			if idx := findBeanIndex(*lib, id); idx != -1 {
				if ext, _ := lib.Beans[idx]["image"].(string); ext != "" {
					imgExt = ext
				}
			}
		}
		filtered := make([]Entity, 0, len(lib.Beans))
		removed := false
		for _, b := range lib.Beans {
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
		lib.Beans = filtered
		return nil
	})
	if err != nil && !errors.Is(err, ErrSkipSave) {
		internalError(w, err)
		return
	}
	if imgExt != "" {
		img.Delete(h.imageDir, id, imgExt, "")
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// toggleBeanActive handles POST /api/library/bean/:id/toggle-active (#578).
//
// id is parsed but NOT validated before calling ToggleBeanActive — passing
// through a noMatch id (0, matching no real bean) rather than
// short-circuiting to 404 here keeps the ordering: a request always reaches
// the DB (ToggleBeanActive's own GetLibrary) before "not found" is decided,
// so a broken/unreachable DB still surfaces as 500 even when the path's {id}
// also happens to be malformed, instead of a malformed id masking a DB outage
// behind a false-negative 404.
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
	h.writeEnrichedBean(w, bean)
}

// knownGrind handles POST /api/library/bean/:id/known-grind (#310).
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

	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		if noMatch {
			return errNotFound
		}
		b, found := UpsertKnownGrindSetting(lib, id, grinderTrimmed, grindSetting)
		if !found {
			return errNotFound
		}
		bean = b
		return nil
	})
	if err != nil {
		writeUpdateError(w, err)
		return
	}
	h.writeEnrichedBean(w, bean)
}

// grindSettingString coerces `String(grindSetting).trim().slice(0, 50)` —
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

// formatJSNumber mirrors JS's String(number): an integral value prints
// without a trailing ".0" (String(22) === "22"), matching what grindSetting
// values (grinder click counts) realistically are.
func formatJSNumber(f float64) string {
	if f == math.Trunc(f) && !math.IsInf(f, 0) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// getBeanImage handles GET /api/library/bean/:id/image.
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

// postBeanImage handles POST /api/library/bean/:id/image (manual upload
// fallback — no URL fetch, no SSRF surface, unlike bean creation's imageUrl
// field).
func (h *Handlers) postBeanImage(w http.ResponseWriter, r *http.Request) {
	if !h.rateLimitImage(w, r) {
		return
	}
	id, noMatch := parseIDParam(r.PathValue("id"))
	// Existence is decided before the upload is read/validated or any file is
	// written: an unknown id 404s even when the image is also invalid, and no
	// orphan file is ever written (matching dev's ordering).
	exists, err := h.entityExists(id, noMatch, findBeanIndex)
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
	ext, ok := img.Save(h.imageDir, "", id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	var bean Entity
	var oldExt string
	err = h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findBeanIndex(*lib, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		oldExt, _ = bean["image"].(string)
		bean["image"] = ext
		lib.Beans[idx] = bean
		return nil
	})
	if err != nil {
		// The entity was deleted between the existence check and the write;
		// the just-saved file has no owner, so drop it.
		img.Delete(h.imageDir, id, ext, "")
		writeUpdateError(w, err)
		return
	}
	if oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "")
	}
	h.writeEnrichedBean(w, bean)
}

// writeEnrichedBean attaches computed bag-queue status (consumedG/
// remainingG/current per bag, remainingG/consumedG on the bean itself —
// see decorateBeanStatus) before responding, so every bean-returning
// endpoint gives the frontend a self-consistent view without it having to
// replay doseRows client-side. allBeans is needed for the same
// beanId-first/name-fallback dose matching ComputeBeanRemaining already
// uses. Falls back to the undecorated bean on a shots-lookup error rather
// than failing the whole request — the mutation itself already succeeded.
func (h *Handlers) writeEnrichedBean(w http.ResponseWriter, bean Entity) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, decorateBeanStatus(bean, doseRows, lib.Beans))
}
