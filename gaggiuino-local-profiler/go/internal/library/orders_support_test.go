package library

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestComputeBeanRemaining_DistinctBagsWithoutOpenedAt_NotMisattributed
// (#901 code review): sameBag must distinguish two bags that both lack
// openedAt (the normal state for any bag recorded before #456 introduced
// bag-open tracking) by identity, not by comparing their openedAt VALUES —
// both are the zero value, so a value comparison would wrongly treat every
// openedAt-less bag as "the same bag" as every other one.
//
// Setup: a bean with two such bags — a stale one, then the current active
// one (bags[len-1]) — and a single dose recorded against the bean. Neither
// bag has openedAt, so bagAtTime resolves the dose to bags[0] (the first
// bag on record, matching the JS original's stable-sort tie-break — see
// LibraryService.js's computeBeanRemaining). Since bags[0] is NOT the
// active bag, the dose must NOT be counted against the active bag's stock:
// remaining must stay at the bean's full stock_g, not stock_g-dose.
func TestComputeBeanRemaining_DistinctBagsWithoutOpenedAt_NotMisattributed(t *testing.T) {
	bean := Entity{
		"id": int64(1), "name": "Test Bean", "stock_g": float64(200),
		"bags": []any{
			Entity{"id": int64(101)}, // stale bag on record, no openedAt
			Entity{"id": int64(102)}, // current active bag, also no openedAt
		},
	}
	dose := 20.0
	beanID := int64(1)
	doseRows := []shots.AnnotatedDose{
		{BeanID: &beanID, Dose: &dose, Timestamp: 1000},
	}

	remaining, ok := ComputeBeanRemaining(bean, doseRows, []Entity{bean})
	if !ok {
		t.Fatalf("ComputeBeanRemaining: ok = false, want true (bean has positive stock_g)")
	}
	if remaining != 200 {
		t.Fatalf("remaining = %d, want 200 — the dose resolves to a DIFFERENT (openedAt-less) bag than the active one and must not be deducted from it", remaining)
	}
}

// TestComputeBeanRemaining_SumsAllTrackedBagsNotJustTheLastOne guards the
// #sortOrder-rework regression: the pre-rework version only ever summed
// bean["stock_g"] and only counted doses against the LAST bag, silently
// dropping stock_g on any other tracked (non-last) bag and every dose
// attributed to it. This mirrors public-src/bean-math.js's
// computeBeanRemaining test coverage — a bean with two independently
// stock-tracked bags, doses against each, must sum both bags' stock and
// deduct doses from whichever bag each one actually belongs to.
func TestComputeBeanRemaining_SumsAllTrackedBagsNotJustTheLastOne(t *testing.T) {
	bean := Entity{
		"id": int64(1), "name": "Test Bean",
		"bags": []any{
			Entity{"id": int64(101), "openedAt": int64(1000), "stock_g": float64(200)},
			Entity{"id": int64(102), "openedAt": int64(5000), "stock_g": float64(300)},
		},
	}
	beanID := int64(1)
	doseA, doseB := 30.0, 40.0
	doseRows := []shots.AnnotatedDose{
		{BeanID: &beanID, Dose: &doseA, Timestamp: 2}, // 2000ms -> resolves to bag 101 (opened at 1000)
		{BeanID: &beanID, Dose: &doseB, Timestamp: 6}, // 6000ms -> resolves to bag 102 (opened at 5000)
	}

	remaining, ok := ComputeBeanRemaining(bean, doseRows, []Entity{bean})
	if !ok {
		t.Fatalf("ComputeBeanRemaining: ok = false, want true")
	}
	// totalStock = 200+300 = 500; consumed = 30+40 = 70 (both bags tracked,
	// both doses correctly attributed) -> 430. The pre-fix version would
	// have summed only bean["stock_g"] (unset here, so 0) and returned
	// ok=false entirely, or — with a bean-level stock_g set instead of
	// per-bag — ignored the bag-101 dose because only the last bag (102)
	// was ever checked.
	if remaining != 430 {
		t.Fatalf("remaining = %d, want 430 (200+300 stock, minus 30+40 doses across both tracked bags)", remaining)
	}
}

// TestSameBag_DistinctMapsWithEqualFieldsAreNotSame is a narrower,
// function-level companion to the ComputeBeanRemaining test above: two
// distinct Entity maps with identical (empty) openedAt must not compare
// equal by sameBag, matching JS's `===` object-reference semantics.
func TestSameBag_DistinctMapsWithEqualFieldsAreNotSame(t *testing.T) {
	a := Entity{"id": int64(1)}
	b := Entity{"id": int64(2)}
	if sameBag(a, b) {
		t.Fatal("sameBag(a, b) = true for two distinct bags that both lack openedAt")
	}
	if !sameBag(a, a) {
		t.Fatal("sameBag(a, a) = false; the exact same bag must compare equal to itself")
	}
}

// TestSimulateBagQueue_ManuallyZeroedBagAdvancesHeadWithoutDoses regresses a
// bug reported live: adjusting a bag's stock down to exactly its own
// consumedG (or straight to 0 via "Als leer markieren") must retire that
// bag immediately, even when no further dose ever gets logged against it —
// the queue's head must not get stuck waiting for a dose event that will
// never come.
func TestSimulateBagQueue_ManuallyZeroedBagAdvancesHeadWithoutDoses(t *testing.T) {
	beanID := int64(1)
	bean := Entity{
		"id": beanID, "name": "Brasil",
		"bags": []any{
			// Manually zeroed out — no doses at all were ever logged for
			// this bean, matching "Bestand anpassen" straight to 0 on a
			// bag that was never actually brewed from.
			Entity{"id": int64(1), "stock_g": float64(0), "openedAt": int64(1000), "sortOrder": int64(0)},
			Entity{"id": int64(2), "stock_g": float64(200), "openedAt": int64(2000), "sortOrder": int64(1)},
		},
	}
	statuses := SimulateBagQueue(bean, nil, []Entity{bean})
	if len(statuses) != 2 {
		t.Fatalf("len(statuses) = %d, want 2", len(statuses))
	}
	if statuses[0].Current {
		t.Fatalf("statuses[0] (zeroed bag) current = true, want false — must not get stuck as current with no doses to advance past it")
	}
	if !statuses[1].Current {
		t.Fatalf("statuses[1] current = false, want true — should take over once bag[0] is exhausted")
	}
	if statuses[0].RemainingG != 0 {
		t.Fatalf("statuses[0].RemainingG = %d, want 0", statuses[0].RemainingG)
	}
}

// TestSimulateBagQueue_SortOrderDeterminesCurrent verifies bag[2] (added
// later, chronologically newer openedAt) never becomes current while
// bag[1] still has stock — the sortOrder queue rule (lowest sortOrder with
// remaining>0 wins) replaces the old "most recently opened bag" rule.
func TestSimulateBagQueue_SortOrderDeterminesCurrent(t *testing.T) {
	beanID := int64(1)
	bean := Entity{
		"id": beanID, "name": "Brasil",
		"bags": []any{
			Entity{"id": int64(1), "stock_g": float64(100), "openedAt": int64(1000), "sortOrder": int64(0)},
			Entity{"id": int64(2), "stock_g": float64(200), "openedAt": int64(2000), "sortOrder": int64(1)},
		},
	}
	statuses := SimulateBagQueue(bean, nil, []Entity{bean})
	if len(statuses) != 2 {
		t.Fatalf("len(statuses) = %d, want 2", len(statuses))
	}
	if !statuses[0].Current || statuses[1].Current {
		t.Fatalf("statuses = %+v; want bag[0] (lowest sortOrder) current, not bag[1]", statuses)
	}
}

// TestSimulateBagQueue_SplitDoseOverflowsIntoNextBag verifies a single dose
// larger than the current bag's remaining stock spills the overflow onto
// the next bag in queue order, and that bag becomes current afterward —
// the "shot empties the bag mid-pull" scenario the sortOrder rework exists
// to handle.
func TestSimulateBagQueue_SplitDoseOverflowsIntoNextBag(t *testing.T) {
	beanID := int64(1)
	bean := Entity{
		"id": beanID, "name": "Brasil",
		"bags": []any{
			Entity{"id": int64(1), "stock_g": float64(15), "openedAt": int64(1000), "sortOrder": int64(0)},
			Entity{"id": int64(2), "stock_g": float64(300), "openedAt": int64(2000), "sortOrder": int64(1)},
		},
	}
	dose := 18.0 // bag1 only has 15g left -> 15g from bag1, 3g overflow into bag2
	doseRows := []shots.AnnotatedDose{{BeanID: &beanID, Dose: &dose, Timestamp: 5000}}
	statuses := SimulateBagQueue(bean, doseRows, []Entity{bean})
	if len(statuses) != 2 {
		t.Fatalf("len(statuses) = %d, want 2", len(statuses))
	}
	if statuses[0].ConsumedG != 15 || statuses[0].RemainingG != 0 {
		t.Fatalf("bag1 = %+v, want consumed=15 remaining=0", statuses[0])
	}
	if statuses[1].ConsumedG != 3 || statuses[1].RemainingG != 297 {
		t.Fatalf("bag2 = %+v, want consumed=3 remaining=297", statuses[1])
	}
	if statuses[0].Current || !statuses[1].Current {
		t.Fatalf("statuses = %+v; want bag2 current after bag1 is exhausted", statuses)
	}
}

// TestSimulateBagQueue_OpenedAtFallbackForLegacyBags verifies bags without
// an explicit sortOrder (data predating this field) still order correctly
// by falling back to openedAt, so old beans don't need a migration.
func TestSimulateBagQueue_OpenedAtFallbackForLegacyBags(t *testing.T) {
	beanID := int64(1)
	bean := Entity{
		"id": beanID, "name": "Brasil",
		"bags": []any{
			// No sortOrder on either bag — must fall back to openedAt, and
			// bag1 (older openedAt) must still resolve as current.
			Entity{"id": int64(1), "stock_g": float64(100), "openedAt": int64(1000)},
			Entity{"id": int64(2), "stock_g": float64(200), "openedAt": int64(2000)},
		},
	}
	statuses := SimulateBagQueue(bean, nil, []Entity{bean})
	if len(statuses) != 2 || !statuses[0].Current || statuses[1].Current {
		t.Fatalf("statuses = %+v; want bag[0] (older openedAt) current", statuses)
	}
}

// TestSimulateBagQueue_StockAdjustRoundTrip is the Go-side equivalent of
// the deleted bean-math.js remainingToStockG/#930 regression test, ported
// to the per-bag model: the frontend's "Bestand anpassen" flow
// (library.js's saveBagStock) computes newStockG as
// `desiredRemaining + bag.consumedG` using SimulateBagQueue's own
// server-computed consumedG — this verifies that round-trip actually lands
// on the desired remaining value when SimulateBagQueue is re-run against
// the adjusted stock_g, for a bag with a non-zero consumedG (i.e. doses
// already logged against it, the case #930 originally regressed on: naively
// setting stock_g to the desired remaining value, ignoring what's already
// been consumed, under-set the bag's stock and made it look emptier than
// the user intended).
func TestSimulateBagQueue_StockAdjustRoundTrip(t *testing.T) {
	beanID := int64(1)
	dose := 18.0
	doseRows := []shots.AnnotatedDose{
		{BeanID: &beanID, Dose: &dose, Timestamp: 1500},
	}
	bean := Entity{
		"id": beanID, "name": "Brasil",
		"bags": []any{
			Entity{"id": int64(1), "stock_g": float64(200), "openedAt": int64(1000), "sortOrder": int64(0)},
		},
	}
	before := SimulateBagQueue(bean, doseRows, []Entity{bean})
	if len(before) != 1 {
		t.Fatalf("len(before) = %d, want 1", len(before))
	}
	if before[0].ConsumedG != 18 {
		t.Fatalf("before[0].ConsumedG = %d, want 18", before[0].ConsumedG)
	}

	const desiredRemaining = int64(50)
	newStockG := desiredRemaining + before[0].ConsumedG // saveBagStock's own formula

	adjusted := Entity{
		"id": beanID, "name": "Brasil",
		"bags": []any{
			Entity{"id": int64(1), "stock_g": float64(newStockG), "openedAt": int64(1000), "sortOrder": int64(0)},
		},
	}
	after := SimulateBagQueue(adjusted, doseRows, []Entity{adjusted})
	if len(after) != 1 {
		t.Fatalf("len(after) = %d, want 1", len(after))
	}
	if after[0].RemainingG != desiredRemaining {
		t.Fatalf("after[0].RemainingG = %d, want %d (the round-trip must land exactly on the desired remaining value)", after[0].RemainingG, desiredRemaining)
	}
}
