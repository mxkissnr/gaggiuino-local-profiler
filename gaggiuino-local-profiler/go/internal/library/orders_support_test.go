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
