package library

import (
	"errors"
	"strings"
	"time"
)

// ApplyAnnotationStock books the milk and frozen-portion side effects of one
// annotation change (#1411). Everything is derived from prev and next — the
// server never trusts client-sent absolute stock values — and the whole change
// runs inside one library Update, so it lands with the annotation save that
// triggered it (cmd/server installs this through shots.SetAnnotationStockHook).
func ApplyAnnotationStock(repo *Repository, menu func() ([]Entity, error), prev, next map[string]any) error {
	prevDrink := annotationText(prev["drinkType"])
	nextDrink := annotationText(next["drinkType"])
	prevMilk := annotationID(prev["milkType"])
	nextMilk := annotationID(next["milkType"])
	prevPortion := annotationID(prev["frozenPortionId"])
	nextPortion := annotationID(next["frozenPortionId"])

	milkChanged := prevDrink != nextDrink || prevMilk != nextMilk
	portionChanged := prevPortion != nextPortion
	if !milkChanged && !portionChanged {
		return nil
	}

	var bookBackMl, deductMl float64
	if milkChanged {
		items, err := menu()
		if err != nil {
			return err
		}
		if prevMilk != 0 {
			bookBackMl = drinkMilkMl(items, prevDrink)
		}
		if nextMilk != 0 {
			deductMl = drinkMilkMl(items, nextDrink)
		}
	}

	err := repo.Update(func(lib *Library) error {
		changed := false
		if bookBackMl > 0 && addMilkStock(lib, prevMilk, bookBackMl) {
			changed = true
		}
		if deductMl > 0 && addMilkStock(lib, nextMilk, -deductMl) {
			changed = true
		}
		if portionChanged {
			if prevPortion != 0 && addPortionRemaining(lib, prevPortion, +1) {
				changed = true
			}
			if nextPortion != 0 && addPortionRemaining(lib, nextPortion, -1) {
				changed = true
			}
		}
		if !changed {
			return ErrSkipSave
		}
		return nil
	})
	if errors.Is(err, ErrSkipSave) {
		return nil
	}
	return err
}

// annotationText reads an annotation string field, trimming surrounding
// whitespace; any non-string value reads as "".
func annotationText(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(s)
}

// annotationID reads an annotation id field; a missing, unparseable or
// non-positive value reads as 0 ("no value").
func annotationID(v any) int64 {
	id, ok := jsParseIntLoose(v)
	if !ok || id <= 0 {
		return 0
	}
	return id
}

// drinkMilkMl returns the milk a menu drink consumes, 0 when the drink is
// unknown or declares no milk.
func drinkMilkMl(menu []Entity, drinkType string) float64 {
	if drinkType == "" {
		return 0
	}
	for _, item := range menu {
		id, _ := item["id"].(string)
		if id != drinkType {
			continue
		}
		ml, ok := jsParseFloat(item["milkMl"])
		if !ok || ml <= 0 {
			return 0
		}
		return ml
	}
	return 0
}

// addMilkStock applies deltaMl to the milk's stock, floored at 0, and stamps
// updatedAt. It reports false when no milk has that id.
func addMilkStock(lib *Library, id int64, deltaMl float64) bool {
	idx := findMilkIndex(*lib, id)
	if idx == -1 {
		return false
	}
	m := lib.Milks[idx]
	stock := floatOrZero(m["stockMl"]) + deltaMl
	if stock < 0 {
		stock = 0
	}
	m["stockMl"] = stock
	m["updatedAt"] = time.Now().UnixMilli()
	return true
}

// addPortionRemaining applies delta to the frozen portion's remainingCount,
// clamped to [0, portionCount], mirroring the adjustFrozenPortion handler: a
// portion that reaches 0 with no thawedAt gets one stamped, and a positive
// count clears it. Portion ids are unique across beans, so every bean is
// searched; it reports false when no bean has the portion.
func addPortionRemaining(lib *Library, portionID, delta int64) bool {
	for _, bean := range lib.Beans {
		p := findFrozenPortion(bean, portionID, false)
		if p == nil {
			continue
		}
		count, _ := jsParseIntLoose(p["portionCount"])
		cur, ok := jsParseIntLoose(p["remainingCount"])
		if !ok {
			cur = count
		}
		rc := min(max(cur+delta, 0), count)
		p["remainingCount"] = rc
		if rc == 0 {
			if _, thawed := p["thawedAt"]; !thawed {
				p["thawedAt"] = newID()
			}
		} else {
			delete(p, "thawedAt")
		}
		return true
	}
	return false
}
