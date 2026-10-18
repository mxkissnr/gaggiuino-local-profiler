package library

import (
	"math"
	"net/http"
)

// freezePortions handles POST /api/library/bean/:id/freeze-portions (#472).
func (h *Handlers) freezePortions(w http.ResponseWriter, r *http.Request) {
	id, noMatch := parseIDParam(r.PathValue("id"))
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	// Freezing attaches to the bag actually being drawn from, which needs the
	// dose replay to identify; a read failure would attach the portion to the
	// wrong bag, so fail rather than guess.
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
		if len(bags) == 0 {
			return errNoActiveBag
		}
		// frozenAt must be strictly a JSON number, not a numeric string (unlike
		// jsParseFloat elsewhere).
		frozenAt, isNum := body["frozenAt"].(float64)
		if !isNum || math.IsInf(frozenAt, 0) {
			frozenAt = float64(newID())
		}
		// A fresh server-side id (rather than letting sanitizeFrozenPortions fall
		// back to frozenAt) keeps two freezes with the same timestamp from sharing
		// an id, which would make thaw/adjust hit the wrong batch.
		candidate := Entity{"id": newID(), "frozenAt": frozenAt, "portionCount": body["portionCount"], "portionWeight_g": body["portionWeight_g"]}
		portions := sanitizeFrozenPortions([]any{candidate})
		if len(portions) == 0 {
			return errPortionFieldsRequired
		}
		newPortion := portions[0]

		// Attach to the queue's current bag — the one actually being drawn
		// from — not the array-last bag (see #sortOrder rework; those can now
		// differ once bags are manually reordered).
		target := currentBag(bean, doseRows, lib.Beans)
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
			idx = findEntityIndex(lib.Beans, id)
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
			idx = findEntityIndex(lib.Beans, id)
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
