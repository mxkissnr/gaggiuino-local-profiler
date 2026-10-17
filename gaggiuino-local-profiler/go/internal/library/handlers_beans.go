package library

import (
	"errors"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file implements the bean endpoints.

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
	bean, err := CreateBean(h.repo, h.imageDir, body)
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
	// UpdateBean writes the body's roastDate/stock_g/batchNumber into the bag
	// actually being drawn from, so it needs the dose rows to find that bag;
	// without them it could only guess, and guessing would edit the wrong bag.
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		internalError(w, err)
		return
	}
	bean, found, err := UpdateBean(h.repo, id, body, doseRows)
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

// isUntouchedPlaceholder reports whether bag is the placeholder the bean form
// creates from a bean's roast date (#1540): no stock, batch number, price or
// frozen portions, and no annotated dose recorded against the bean. Such a bag
// isn't a real bag yet, so the first bag the user adds should fill it in place
// instead of stacking a second, empty one behind it.
func isUntouchedPlaceholder(beanID int64, bag Entity, doseRows []shots.AnnotatedDose) bool {
	if v, ok := bag["stock_g"]; ok && v != nil {
		return false
	}
	if trimMax(bag["batchNumber"], 50) != "" {
		return false
	}
	if v, ok := bag["price_eur"]; ok && v != nil {
		return false
	}
	if fps, _ := bag["frozenPortions"].([]any); len(fps) > 0 {
		return false
	}
	for _, row := range doseRows {
		if row.BeanID != nil && *row.BeanID == beanID {
			return false
		}
	}
	return true
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
			idx = findEntityIndex(lib.Beans, id)
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
		var bagID int64
		var bag Entity
		// #1540: the bean form creates a single placeholder bag from the bean's
		// roast date and no stock; "Save and add bag" must fill that bag in
		// rather than append an empty one behind it, which otherwise leaves a
		// phantom Past bag and drops the bean's age badge (the bean-level
		// roastDate syncs from the new, dateless current bag).
		if len(bags) == 1 {
			if ph, ok := bags[0].(Entity); ok && isUntouchedPlaceholder(id, ph, doseRows) {
				if phID, ok := idOf(ph, "id"); ok {
					bagID = phID
					if roastDate == "" {
						roastDate = trimMax(ph["roastDate"], 10)
					}
					// Keep the placeholder's id/openedAt/sortOrder — only the
					// fields the user entered change.
					ph["roastDate"] = roastDate
					ph["stock_g"] = stockG
					ph["batchNumber"] = batchNumber
					ph["price_eur"] = priceEur
					bag = ph
				}
			}
		}
		if bag == nil {
			// New bag always joins the back of the queue (highest sortOrder + 1) —
			// it does NOT become current just by existing; SimulateBagQueue only
			// promotes it once every bag ahead of it in the queue is exhausted.
			var nextSort int64
			for _, raw := range bags {
				if bg, ok := raw.(Entity); ok {
					nextSort = maxInt64(nextSort, effectiveSortOrder(bg)+1)
				}
			}
			bagID = newID()
			bag = Entity{"id": bagID, "roastDate": roastDate, "stock_g": stockG, "openedAt": newID(), "batchNumber": batchNumber, "price_eur": priceEur, "sortOrder": nextSort}
			bean["bags"] = append(bags, bag)
		}
		// Sync bean-level fields only when this bag is the one
		// SimulateBagQueue actually considers current (i.e. every other bag
		// was already exhausted, so this one is drawn from immediately) — not
		// unconditionally, which would overwrite the bean's displayed roast
		// date/stock with a bag still queued behind the real current one.
		if cur := currentBag(bean, doseRows, lib.Beans); cur != nil {
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
	// The upcoming set is exactly the bags the client may reorder, so this
	// needs the same dose replay SimulateBagQueue does — without it an
	// already-emptied past bag looks "upcoming" and a still-full bag looks
	// current. A read failure here would misclassify them and wrongly accept
	// or reject the request, so fail rather than guess.
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		internalError(w, err)
		return
	}
	var bean Entity
	err = h.repo.Update(func(lib *Library) error {
		idx := -1
		if !noMatch {
			idx = findEntityIndex(lib.Beans, id)
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
		statuses := SimulateBagQueue(bean, doseRows, lib.Beans)
		baseline := int64(0)
		currentBagID := int64(-1)
		if cur := currentBag(bean, doseRows, lib.Beans); cur != nil {
			baseline = effectiveSortOrder(cur)
			if cid, ok := idOf(cur, "id"); ok {
				currentBagID = cid
			}
		}
		// bagIds must be exactly the set of "upcoming" bags the client can
		// reorder — tracked (SimulateBagQueue resolved it), not current, and
		// still with stock left (classifyBeanBags' `upcoming`) — no
		// duplicates, none missing. Past/emptied and untracked bags are
		// neither required nor allowed. Assigning sortOrder to only a subset
		// would leave the omitted bags' old values unchanged, which can now
		// collide with or fall between the freshly-assigned ones (the new
		// values are baseline+1, baseline+2, ... contiguous integers, so any
		// stale value in that range is no longer guaranteed unique); a
		// duplicate id in the request would just assign it a sortOrder twice,
		// silently discarding whichever assignment came first.
		upcoming := make(map[int64]bool, len(bags))
		for _, s := range statuses {
			if s.Current || s.RemainingG <= 0 {
				continue
			}
			upcoming[s.BagID] = true
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

// deleteBean handles POST /api/library/bean/:id/delete.
func (h *Handlers) deleteBean(w http.ResponseWriter, r *http.Request) {
	h.deleteEntity(w, r, beanKind, nil)
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
	h.getEntityImage(w, r, beanKind)
}

// postBeanImage handles POST /api/library/bean/:id/image (manual upload
// fallback — no URL fetch, no SSRF surface, unlike bean creation's imageUrl
// field). Beans answer with the enriched bean, so they pass writeEnrichedBean
// as the success responder.
func (h *Handlers) postBeanImage(w http.ResponseWriter, r *http.Request) {
	h.postEntityImage(w, r, beanKind, h.writeEnrichedBean)
}

// writeEnrichedBean attaches computed bag-queue status (consumedG/
// remainingG/current per bag, remainingG/consumedG on the bean itself —
// see decorateBeanStatus) before responding, so every bean-returning
// endpoint gives the frontend a self-consistent view without it having to
// replay doseRows client-side. allBeans is needed for the same
// beanId-first/name-fallback dose matching ComputeBeanRemaining already
// uses. On a library- or shots-lookup error it logs and answers 200 with the
// undecorated bean rather than failing the whole request — the mutation
// itself already succeeded, so a 500 here would only make the client retry a
// change it already made.
func (h *Handlers) writeEnrichedBean(w http.ResponseWriter, bean Entity) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		log.Printf("library: reading library to decorate bean response: %v", err)
		writeJSON(w, http.StatusOK, bean)
		return
	}
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		log.Printf("library: reading doses to decorate bean response: %v", err)
		writeJSON(w, http.StatusOK, bean)
		return
	}
	writeJSON(w, http.StatusOK, decorateBeanStatus(bean, doseRows, lib.Beans))
}
