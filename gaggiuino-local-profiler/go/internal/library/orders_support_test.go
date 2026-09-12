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
