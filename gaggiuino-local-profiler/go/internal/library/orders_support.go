package library

import (
	"reflect"
	"sort"
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
// ComputeBeanRemaining mirrors public-src/bean-math.js's computeBeanRemaining
// exactly (same signature, same beanId-first-with-name-fallback matching,
// same FIFO-across-tracked-bags accumulation, same double-round) — the two
// must never drift apart, since this is the SPA's own display value on one
// side and the SSR/achievements/orders low-stock paths' value on the other.
//
// "Tracked bags" are every bag with a positive stock_g (falling back to
// bean["stock_g"] for the last bag when it has none of its own, for bags
// predating per-bag stock tracking) — not just the single last/active bag
// the pre-#sortOrder-rework version assumed. A dose is attributed to
// whichever bag was open at the shot's timestamp (bagAtTime) and only
// counts against the total when that bag is itself tracked; there's no
// per-bag clamp, so a dose recorded against one tracked bag's period can
// still draw down a later tracked bag's stock in the running total (true
// FIFO), matching the JS implementation's own doc comment.
func ComputeBeanRemaining(bean Entity, doseRows []shots.AnnotatedDose, allBeans []Entity) (int64, bool) {
	bags := bagsOf(bean)
	name := lowerOrEmpty(strOf(bean["name"]))
	beanID, hasBeanID := idOf(bean, "id")

	idExists := make(map[int64]bool, len(allBeans))
	for _, b := range allBeans {
		if bid, ok := idOf(b, "id"); ok {
			idExists[bid] = true
		}
	}

	if len(bags) == 0 {
		stockG, hasStock := jsParseFloat(bean["stock_g"])
		if !hasStock || !(stockG > 0) {
			return 0, false
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
			if matches {
				consumed += *row.Dose
			}
		}
		return mathRoundInt(stockG - float64(mathRoundInt(consumed))), true
	}

	var totalStock float64
	// Entity (map[string]any) isn't hashable, so "tracked-ness" is a slice
	// checked via sameBag's pointer-identity comparison (matching bagAtTime's
	// own convention) rather than a map keyed by the bag itself — bag counts
	// are small (single digits in practice), so the linear scan below is fine.
	var trackedBags []Entity
	for i, raw := range bags {
		bg, ok := raw.(Entity)
		if !ok {
			continue
		}
		s, hasStock := jsParseFloat(bg["stock_g"])
		if !hasStock && i == len(bags)-1 {
			s, hasStock = jsParseFloat(bean["stock_g"])
		}
		if hasStock && s > 0 {
			totalStock += s
			trackedBags = append(trackedBags, bg)
		}
	}
	if !(totalStock > 0) {
		return 0, false
	}
	isTracked := func(bg Entity) bool {
		for _, tb := range trackedBags {
			if sameBag(tb, bg) {
				return true
			}
		}
		return false
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
		bagAtShotTime := bagAtTime(bags, row.Timestamp*1000)
		if isTracked(bagAtShotTime) {
			consumed += *row.Dose
		}
	}
	// Mirrors `Math.round(Math.max(0, totalStock - Math.round(consumed)))`
	// exactly — two separate rounds, not one round of the difference.
	remaining := mathRoundInt(totalStock - float64(mathRoundInt(consumed)))
	if remaining < 0 {
		remaining = 0
	}
	return remaining, true
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

// BagStatus is one bag's computed (never persisted) queue position and
// consumption after replaying every dose matching its bean, in sortOrder.
type BagStatus struct {
	BagID      int64
	ConsumedG  int64
	RemainingG int64
	Current    bool
}

// SimulateBagQueue is the single source of truth for "which bag is
// current" and "how much has each bag consumed" — replaces the old
// bags[len-1]/most-recently-opened convention with a manually-orderable
// queue (see #sortOrder rework). Tracked bags (finite, non-negative
// stock_g — the trailing bag falls back to bean.stock_g exactly like
// ComputeBeanRemaining, for beans predating per-bag stock tracking) are
// sorted by effectiveSortOrder ascending. Every matching dose (chronological
// order) is drawn from the queue head; once a bag's stock_g is exhausted the
// head advances to the next bag and the remainder of that same dose is
// drawn from it too — this is what makes a shot that empties the current
// bag mid-pull correctly spill its overflow onto the next one. Untracked
// bags (no stock_g ever set) are omitted entirely: we don't know their
// capacity, so we can't say anything about their consumption or make them
// current.
//
// frozenPortions is deliberately NOT subtracted from a bag's available
// stock here: saveFreezePortions' own doc comment (handlers_beans.go)
// states freezing "doesn't consume anything, it just pauses that portion's
// freshness clock" — stock_g stays the bag's total gram count regardless
// of how much of it is currently frozen. A review pass flagged this
// function as "ignoring frozenPortions"; after checking that comment, that
// reads as the intended behavior, not a bug — changing it would contradict
// the documented freeze/thaw design elsewhere in this package.
func SimulateBagQueue(bean Entity, doseRows []shots.AnnotatedDose, allBeans []Entity) []BagStatus {
	bags := bagsOf(bean)
	if len(bags) == 0 {
		return nil
	}
	type qEntry struct {
		id     int64
		sort   int64
		stockG float64
	}
	var queue []qEntry
	for i, raw := range bags {
		bg, ok := raw.(Entity)
		if !ok {
			continue
		}
		stockG, hasStock := jsParseFloat(bg["stock_g"])
		if !hasStock && i == len(bags)-1 {
			stockG, hasStock = jsParseFloat(bean["stock_g"])
		}
		if !hasStock || stockG < 0 {
			continue
		}
		id, _ := idOf(bg, "id")
		queue = append(queue, qEntry{id, effectiveSortOrder(bg), stockG})
	}
	if len(queue) == 0 {
		return nil
	}
	sort.Slice(queue, func(i, j int) bool { return queue[i].sort < queue[j].sort })

	name := lowerOrEmpty(strOf(bean["name"]))
	beanID, hasBeanID := idOf(bean, "id")
	idExists := make(map[int64]bool, len(allBeans))
	for _, b := range allBeans {
		if bid, ok := idOf(b, "id"); ok {
			idExists[bid] = true
		}
	}
	matches := func(row shots.AnnotatedDose) bool {
		if row.BeanID != nil && idExists[*row.BeanID] {
			return hasBeanID && *row.BeanID == beanID
		}
		return lowerOrEmpty(row.Coffee) == name
	}
	rows := make([]shots.AnnotatedDose, 0, len(doseRows))
	for _, row := range doseRows {
		if row.Dose == nil || *row.Dose == 0 || !matches(row) {
			continue
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Timestamp < rows[j].Timestamp })

	consumed := make([]float64, len(queue))
	head := 0
	for _, row := range rows {
		remainingDose := *row.Dose
		for remainingDose > 0 && head < len(queue) {
			avail := queue[head].stockG - consumed[head]
			if avail < 0 {
				avail = 0
			}
			take := remainingDose
			if avail < take {
				take = avail
			}
			consumed[head] += take
			remainingDose -= take
			if consumed[head] >= queue[head].stockG {
				head++
			} else {
				break
			}
		}
	}
	// A bag manually zeroed out (stock_g set to exactly its own consumedG,
	// or created with stock_g:0 outright — "Als leer markieren"/"Bestand
	// anpassen" to 0) is exhausted from the moment it's saved, whether or
	// not another dose ever gets logged against it. The advance-head check
	// above only fires from inside the dose-processing loop, so a bag that
	// starts (or ends up) exhausted with no further matching doses to
	// trigger it would otherwise sit stuck at `head` forever, still
	// reporting current:true. Sweep past every already-exhausted bag once
	// more after the replay, independent of whether any dose touched it.
	for head < len(queue) && consumed[head] >= queue[head].stockG {
		head++
	}
	out := make([]BagStatus, len(queue))
	for i, e := range queue {
		rem := e.stockG - consumed[i]
		if rem < 0 {
			rem = 0
		}
		out[i] = BagStatus{
			BagID:      e.id,
			ConsumedG:  mathRoundInt(consumed[i]),
			RemainingG: mathRoundInt(rem),
			Current:    i == head,
		}
	}
	return out
}

// decorateBeanStatus returns a copy of bean with computed, non-persisted
// status fields attached — the bean-level counterpart of getLibrary's
// existing withWearEntity grinder decoration. bean-level remainingG mirrors
// ComputeBeanRemaining (attribution-independent, so it's correct regardless
// of queue order); consumedG is the sum of SimulateBagQueue's per-bag
// consumption. Every bag gets consumedG/remainingG/current attached so the
// frontend never has to replay doseRows itself — only bags SimulateBagQueue
// could resolve (tracked ones) get these fields; untracked bags are left
// untouched.
func decorateBeanStatus(bean Entity, doseRows []shots.AnnotatedDose, allBeans []Entity) Entity {
	out := make(Entity, len(bean)+2)
	for k, v := range bean {
		out[k] = v
	}
	if remaining, ok := ComputeBeanRemaining(bean, doseRows, allBeans); ok {
		out["remainingG"] = remaining
	}
	statuses := SimulateBagQueue(bean, doseRows, allBeans)
	if len(statuses) == 0 {
		return out
	}
	statusByID := make(map[int64]BagStatus, len(statuses))
	var totalConsumed int64
	for _, s := range statuses {
		statusByID[s.BagID] = s
		totalConsumed += s.ConsumedG
	}
	out["consumedG"] = totalConsumed
	bags := bagsOf(bean)
	newBags := make([]any, len(bags))
	for i, raw := range bags {
		bg, ok := raw.(Entity)
		if !ok {
			newBags[i] = raw
			continue
		}
		id, hasID := idOf(bg, "id")
		st, found := statusByID[id]
		if !hasID || !found {
			newBags[i] = bg
			continue
		}
		nb := make(Entity, len(bg)+3)
		for k, v := range bg {
			nb[k] = v
		}
		nb["consumedG"] = st.ConsumedG
		nb["remainingG"] = st.RemainingG
		nb["current"] = st.Current
		newBags[i] = nb
	}
	out["bags"] = newBags
	return out
}

// resolveCurrentBagSimple picks the current bag for Go call sites (freeze)
// that don't need gram-accurate consumption — just "which bag is the user
// drawing from right now": the lowest-effectiveSortOrder bag with a
// positive stock_g. Falls back to the array-last bag (old convention) when
// no bag is stock-tracked at all, so freezing on an untracked bean still
// attaches somewhere sensible.
func resolveCurrentBagSimple(bean Entity) Entity {
	bags := bagsOf(bean)
	if len(bags) == 0 {
		return nil
	}
	var best Entity
	bestSort := int64(0)
	for _, raw := range bags {
		bg, ok := raw.(Entity)
		if !ok {
			continue
		}
		stockG, hasStock := jsParseFloat(bg["stock_g"])
		if !hasStock || !(stockG > 0) {
			continue
		}
		s := effectiveSortOrder(bg)
		if best == nil || s < bestSort {
			best, bestSort = bg, s
		}
	}
	if best != nil {
		return best
	}
	return activeBag(bean)
}
