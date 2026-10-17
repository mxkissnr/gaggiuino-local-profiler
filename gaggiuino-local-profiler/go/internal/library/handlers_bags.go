package library

import (
	"log"
	"net/http"
	"time"
)

// deleteBag handles DELETE /api/library/bean/:id/bag/:bagId.
func (h *Handlers) deleteBag(w http.ResponseWriter, r *http.Request) {
	id, idNoMatch := parseIDParam(r.PathValue("id"))
	bagID, bagNoMatch := parseIDParam(r.PathValue("bagId"))
	// Best-effort read: deleteBag's currentBag use is only the bean-level
	// roastDate/stock_g sync below, so a shots-lookup failure skips that sync
	// rather than failing an otherwise valid delete.
	doseRows, doseErr := h.shotsRepo.GetAnnotatedDoses()
	if doseErr != nil {
		log.Printf("library: reading doses for current-bag sync: %v", doseErr)
	}
	var bean Entity
	err := h.repo.Update(func(lib *Library) error {
		idx := -1
		if !idNoMatch {
			idx = findEntityIndex(lib.Beans, id)
		}
		if idx == -1 {
			return errNotFound
		}
		bean = lib.Beans[idx]
		bags := bagsOf(bean)
		if len(bags) <= 1 {
			return errCannotDeleteLastBag
		}
		// An unknown (or malformed) bagId removes nothing: 404 rather than a
		// silent 200 that leaves the bean untouched.
		found := false
		filtered := make([]any, 0, len(bags))
		for _, b := range bags {
			bag, _ := b.(Entity)
			bgID, ok := idOf(bag, "id")
			if !bagNoMatch && ok && bgID == bagID {
				found = true
				continue
			}
			filtered = append(filtered, b)
		}
		if !found {
			return errNotFound
		}
		bean["bags"] = filtered
		// Sync bean-level roastDate/stock_g from the bag actually being drawn
		// from, not the array-last bag (they differ once the queue has
		// advanced or bags are reordered). With no current bag left the
		// bean-level fields stay unchanged. Skipped entirely when the dose read
		// failed: without the dose history currentBag could resolve the wrong
		// bag and write its date/stock into the bean.
		if doseErr == nil {
			if cur := currentBag(bean, doseRows, lib.Beans); cur != nil {
				bean["roastDate"] = cur["roastDate"]
				bean["stock_g"] = cur["stock_g"]
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

// bagEditedFields are the keys updateBag rewrites on a bag; sanitizeBag drops
// them from the copied bag before re-deriving each from the raw value, so the
// "keep every other key unchanged" rule is expressed once.
var bagEditedFields = map[string]bool{
	"roastDate": true, "stock_g": true, "price_eur": true,
	"batchNumber": true, "sortOrder": true, "frozenPortions": true,
}

// sanitizeBag re-applies updateBag's field rules to a single bag restored
// from a backup (#1603), so a crafted backup can't smuggle in a bag the edit
// route would reject. ok is false for a non-object entry, which the caller
// drops; structural keys (id, openedAt, emptiedAt, ...) are kept as-is.
// Unlike updateBag, a future roastDate is kept rather than 400'd (restore
// enforces length, not the client clock) and stock_g/price_eur that fail
// validateBagFloatField become nil instead of aborting the restore.
func sanitizeBag(raw any) (Entity, bool) {
	bag, ok := raw.(Entity)
	if !ok {
		return nil, false
	}
	out := Entity{}
	for k, v := range bag {
		if !bagEditedFields[k] {
			out[k] = v
		}
	}
	stockG, _ := validateBagFloatField(bag, "stock_g")
	priceEur, _ := validateBagFloatField(bag, "price_eur")
	sortOrder, sortOK := jsParseIntLoose(bag["sortOrder"])
	if !sortOK {
		sortOrder = effectiveSortOrder(bag)
	}
	out["roastDate"] = trimMax(bag["roastDate"], 10)
	out["stock_g"] = stockG
	out["price_eur"] = priceEur
	out["batchNumber"] = trimMax(bag["batchNumber"], 50)
	out["sortOrder"] = sortOrder
	out["frozenPortions"] = sanitizeFrozenPortions(bag["frozenPortions"])
	return out, true
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
// bag is the one actually being drawn from, bean-level roastDate and stock_g
// are synced to it.
func (h *Handlers) updateBag(w http.ResponseWriter, r *http.Request) {
	id, idNoMatch := parseIDParam(r.PathValue("id"))
	bagID, bagNoMatch := parseIDParam(r.PathValue("bagId"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	// Best-effort read: updateBag's currentBag use is only the bean-level
	// roastDate/stock_g sync below, so a shots-lookup failure skips that sync
	// rather than failing an otherwise valid bag edit.
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		log.Printf("library: reading doses for current-bag sync: %v", err)
	}
	var bean Entity
	err = h.repo.Update(func(lib *Library) error {
		idx := -1
		if !idNoMatch {
			idx = findEntityIndex(lib.Beans, id)
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
	h.writeEnrichedBean(w, bean)
}
