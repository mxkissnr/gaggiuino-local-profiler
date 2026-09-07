package library

import (
	"reflect"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports the LibraryService.js methods the Phase 1f orders domain
// needs (getActiveBeans, getActiveMilks, deductMilkByName,
// computeBeanRemaining) — deferred out of Phase 1d's scope (see doc.go),
// now needed by internal/orders/service.go for GET /api/orders/active-beans,
// GET /api/orders/active-milks, and the milk-stock deduction
// OrderService.completeOrder runs. Kept in this package (not orders' own)
// for the same reason ComputeGrinderWearStats lives in service.go: only
// this package has direct Repository access to the `library` table.

// ComputeBeanRemaining ports LibraryService.js's computeBeanRemaining:
// remaining grams for a stock-tracked bean, matching doseRows against the
// bean by stable beanId first (#456), falling back to case-insensitive name
// matching for rows that predate it or whose beanId no longer resolves to
// any existing bean. Returns (0, false) for a bean with no tracked stock
// (bean.stock_g not set/positive), matching the Node original's `null`.
func ComputeBeanRemaining(bean Entity, doseRows []shots.AnnotatedDose, allBeans []Entity) (int64, bool) {
	stockG, hasStock := jsParseFloat(bean["stock_g"])
	if !hasStock || !(stockG > 0) {
		return 0, false
	}
	bags := bagsOf(bean)
	name := lowerOrEmpty(strOf(bean["name"]))
	beanID, hasBeanID := idOf(bean, "id")

	idExists := make(map[int64]bool, len(allBeans))
	for _, b := range allBeans {
		if bid, ok := idOf(b, "id"); ok {
			idExists[bid] = true
		}
	}

	var activeBagEntity Entity
	if len(bags) > 0 {
		if m, ok := bags[len(bags)-1].(Entity); ok {
			activeBagEntity = m
		}
	}

	var consumed float64
	for _, row := range doseRows {
		if row.Dose == nil || *row.Dose == 0 {
			continue
		}
		var matches bool
		if row.BeanID != nil && idExists[*row.BeanID] {
			matches = hasBeanID && *row.BeanID == beanID
		} else {
			matches = lowerOrEmpty(row.Coffee) == name
		}
		if !matches {
			continue
		}
		if activeBagEntity != nil {
			shotMs := row.Timestamp * 1000
			bagAtShotTime := bagAtTime(bags, shotMs)
			if !sameBag(bagAtShotTime, activeBagEntity) {
				continue
			}
		}
		consumed += *row.Dose
	}
	// Mirrors `Math.round(bean.stock_g - Math.round(consumed))` exactly —
	// two separate rounds, not one round of the difference.
	return mathRoundInt(stockG - float64(mathRoundInt(consumed))), true
}

// mathRoundInt ports JS's Math.round as an int64 result: round-half-up
// (ties round toward +Infinity), unlike Go's math.Round (round-half-away-
// from-zero). Doses and stock are never negative in practice (parseFloat
// (dose)||0, stock_g is a non-negative field), so this only needs to be
// correct for that domain, same scope as service.go's roundTo1.
func mathRoundInt(f float64) int64 {
	if f >= 0 {
		return int64(f + 0.5)
	}
	return -int64(-f + 0.5)
}

// bagAtTime ports the "which bag was active at this shot's time" resolution
// duplicated in computeBeanRemaining: the most recently opened bag whose
// openedAt is <= shotMs, falling back to the oldest bag on record (bags[0])
// for a shot that predates every recorded bag.
func bagAtTime(bags []any, shotMs int64) Entity {
	var best Entity
	var bestOpenedAt int64 = -1
	for _, raw := range bags {
		bag, ok := raw.(Entity)
		if !ok {
			continue
		}
		openedAt, _ := idOf(bag, "openedAt")
		if openedAt <= shotMs && openedAt > bestOpenedAt {
			best = bag
			bestOpenedAt = openedAt
		}
	}
	if best != nil {
		return best
	}
	if len(bags) > 0 {
		if b, ok := bags[0].(Entity); ok {
			return b
		}
	}
	return nil
}

// sameBag ports the Node original's object-reference identity check (`bag
// === activeBag`), NOT a value comparison of the bags' fields. Comparing by
// openedAt value instead (#901 code review) is wrong: two bags of the same
// bean that both predate #456's openedAt tracking share the zero value for
// that field and would be misidentified as the same bag, corrupting
// ComputeBeanRemaining's per-bag dose matching. Entity is a map, so `==`
// isn't usable directly (maps aren't comparable in Go); reflect.Pointer
// compares the two maps' underlying data pointers instead, which is
// reference identity for exactly the same reason JS's `===` is on two
// object bindings — every bag in a bean's `bags` slice is a distinct map
// value (decoded from JSON, or built by a copying helper), so this only
// ever reports true when a and b are literally the same bag, never a
// same-shaped clone of it.
func sameBag(a, b Entity) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return reflect.ValueOf(a).Pointer() == reflect.ValueOf(b).Pointer()
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

func lowerOrEmptyAny(v any) string {
	return lowerOrEmpty(strOf(v))
}

// GetActiveBeans ports LibraryService.js's getActiveBeans(): stock-tracked
// beans still in stock (remaining > 0) and not manually disabled, shaped
// for the order card.
func GetActiveBeans(lib Library, doseRows []shots.AnnotatedDose) []Entity {
	out := make([]Entity, 0, len(lib.Beans))
	for _, bean := range lib.Beans {
		remaining, ok := ComputeBeanRemaining(bean, doseRows, lib.Beans)
		// `bean.enabled !== false` — a strict inequality check against the
		// literal boolean false, not sanitizeEnabled's broader "falsy-ish"
		// coercion (which also treats the strings 'false'/'0' and the
		// number 0 as disabled): getActiveBeans() in Node uses the
		// narrower check, and bean.enabled is already normalized to a real
		// boolean by sanitizeEnabled at every write path, so the two only
		// diverge for a hand-edited DB row — matched exactly here anyway.
		if !ok || remaining <= 0 || bean["enabled"] == false {
			continue
		}
		origins, _ := bean["origins"].([]any)
		if len(origins) == 0 {
			origins = []any{}
			if code := strOf(bean["origin"]); code != "" {
				origins = []any{Entity{"code": code}}
			}
		}
		out = append(out, Entity{
			"id":        bean["id"],
			"name":      bean["name"],
			"roaster":   strOrNull(bean, "roaster"),
			"decaf":     boolOf(bean["decaf"]),
			"remaining": remaining,
			"notes":     strOrNull(bean, "notes"),
			"origin":    strOrNull(bean, "origin"),
			"process":   strOrNull(bean, "process"),
			"variety":   strOrNull(bean, "variety"),
			"species":   strOrNull(bean, "species"),
			"category":  categoryOrDefault(bean),
			"origins":   origins,
		})
	}
	return out
}

func categoryOrDefault(bean Entity) string {
	c := strOf(bean["category"])
	if c == "" {
		return "normal"
	}
	return c
}

// GetActiveMilks ports LibraryService.js's getActiveMilks(): milks with
// positive stock, shaped for the order card.
func GetActiveMilks(lib Library) []Entity {
	out := make([]Entity, 0, len(lib.Milks))
	for _, m := range lib.Milks {
		stockMl, _ := jsParseFloat(m["stockMl"])
		if !(stockMl > 0) {
			continue
		}
		out = append(out, Entity{
			"id":        m["id"],
			"name":      m["name"],
			"emoji":     strOrNull(m, "emoji"),
			"remaining": stockMl,
		})
	}
	return out
}

// DeductMilkByName ports LibraryService.js's deductMilkByName(name, ml):
// case-insensitive name match, clamped at 0, no-op if no match or the
// deduction amount isn't positive. Returns (Entity, true) for the updated
// milk on success.
func DeductMilkByName(repo *Repository, name string, ml float64) (Entity, bool, error) {
	if name == "" || !(ml > 0) {
		return nil, false, nil
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, false, err
	}
	key := lowerOrEmpty(name)
	idx := -1
	for i, m := range lib.Milks {
		if lowerOrEmptyAny(m["name"]) == key {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, false, nil
	}
	milk := lib.Milks[idx]
	stockMl, _ := jsParseFloat(milk["stockMl"])
	newStock := stockMl - ml
	if newStock < 0 {
		newStock = 0
	}
	milk["stockMl"] = newStock
	milk["updatedAt"] = time.Now().UnixMilli()
	lib.Milks[idx] = milk
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, false, err
	}
	return milk, true, nil
}
