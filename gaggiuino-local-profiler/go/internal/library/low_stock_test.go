package library

import (
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// lowStockBag builds a bag Entity shaped like one decoded from the library
// blob (numeric fields are float64, the []any element type bagsOf expects).
func lowStockBag(id, openedAt int64, stockG float64) Entity {
	return Entity{
		"id":       float64(id),
		"openedAt": float64(openedAt),
		"stock_g":  float64(stockG),
	}
}

// saveLowStockBean writes a single bean (id 10, "Ethiopia") carrying bags.
func saveLowStockBean(t *testing.T, repo *Repository, bags ...Entity) {
	t.Helper()
	list := make([]any, 0, len(bags))
	for _, b := range bags {
		list = append(list, b)
	}
	bean := Entity{"id": float64(10), "name": "Ethiopia", "bags": list}
	if err := repo.SaveLibrary(Library{Beans: []Entity{bean}}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

func noDoses() ([]shots.AnnotatedDose, error) { return nil, nil }

// bagStamp reads a bag's stored lowStockNotifiedAt, reporting whether it is
// present at all.
func bagStamp(t *testing.T, repo *Repository, bagID int64) (float64, bool) {
	t.Helper()
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	for _, bean := range lib.Beans {
		for _, raw := range bagsOf(bean) {
			bag, _ := raw.(Entity)
			if id, _ := idOf(bag, "id"); id != bagID {
				continue
			}
			v, present := bag["lowStockNotifiedAt"]
			if !present {
				return 0, false
			}
			f, _ := jsParseFloat(v)
			return f, true
		}
	}
	t.Fatalf("bag %d not found", bagID)
	return 0, false
}

func TestCheckLowStock_NotifiesOncePerBag(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 84))

	var calls int
	var gotName string
	var gotG int64
	notify := func(name string, g int64) bool {
		calls++
		gotName, gotG = name, g
		return true
	}

	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, notify); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if calls != 1 {
		t.Fatalf("notify called %d times, want 1", calls)
	}
	if gotName != "Ethiopia" || gotG != 84 {
		t.Fatalf("notify(%q, %d), want (\"Ethiopia\", 84)", gotName, gotG)
	}
	if _, ok := bagStamp(t, repo, 11); !ok {
		t.Fatal("lowStockNotifiedAt not stored on the notified bag")
	}

	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, notify); err != nil {
		t.Fatalf("second CheckLowStock: %v", err)
	}
	if calls != 1 {
		t.Fatalf("notify called %d times after the first, want still 1", calls)
	}
}

func TestCheckLowStock_NewCurrentBagRearms(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 84))
	alwaysNotify := func(string, int64) bool { return true }
	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, alwaysNotify); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if _, ok := bagStamp(t, repo, 11); !ok {
		t.Fatal("first bag not stamped")
	}

	// A new bag becomes current: the first is empty, the second carries stock.
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 0), lowStockBag(12, 2_000, 84))
	var calls int
	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, func(string, int64) bool { calls++; return true }); err != nil {
		t.Fatalf("CheckLowStock (new bag): %v", err)
	}
	if calls != 1 {
		t.Fatalf("notify called %d times for the new current bag, want 1", calls)
	}
	if _, ok := bagStamp(t, repo, 12); !ok {
		t.Fatal("new current bag not stamped")
	}
}

func TestCheckLowStock_NotStampedWhenNotifyFails(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 84))

	var calls int
	fail := func(string, int64) bool { calls++; return false }
	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, fail); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if _, ok := bagStamp(t, repo, 11); ok {
		t.Fatal("lowStockNotifiedAt stored despite the push failing")
	}
	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, fail); err != nil {
		t.Fatalf("second CheckLowStock: %v", err)
	}
	if calls != 2 {
		t.Fatalf("notify called %d times, want 2 (retried after the failed push)", calls)
	}
}

func TestCheckLowStock_AtThresholdNoNotify(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, float64(DefaultLowStockThresholdG)))

	var calls int
	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, func(string, int64) bool { calls++; return true }); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if calls != 0 {
		t.Fatalf("notify called %d times at the threshold, want 0", calls)
	}
	if _, ok := bagStamp(t, repo, 11); ok {
		t.Fatal("bag stamped at the threshold")
	}
}

func TestCheckLowStock_UnknownBeanNoop(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 84))

	var calls int
	if err := CheckLowStock(repo, noDoses, 999, DefaultLowStockThresholdG, func(string, int64) bool { calls++; return true }); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if calls != 0 {
		t.Fatalf("notify called %d times for an unknown bean, want 0", calls)
	}
}

// TestCheckLowStock_CustomThreshold pins #1835: the caller's threshold decides
// the notification, not the built-in default. 84 g left stays quiet under a
// 50 g threshold and fires under a 90 g one.
func TestCheckLowStock_CustomThreshold(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 84))

	var calls int
	notify := func(string, int64) bool { calls++; return true }
	if err := CheckLowStock(repo, noDoses, 10, 50, notify); err != nil {
		t.Fatalf("CheckLowStock below a 50 g threshold: %v", err)
	}
	if calls != 0 {
		t.Fatalf("notify called %d times with a 50 g threshold and 84 g left, want 0", calls)
	}
	if _, ok := bagStamp(t, repo, 11); ok {
		t.Fatal("bag stamped although the threshold was not crossed")
	}

	if err := CheckLowStock(repo, noDoses, 10, 90, notify); err != nil {
		t.Fatalf("CheckLowStock below a 90 g threshold: %v", err)
	}
	if calls != 1 {
		t.Fatalf("notify called %d times with a 90 g threshold and 84 g left, want 1", calls)
	}
	if _, ok := bagStamp(t, repo, 11); !ok {
		t.Fatal("lowStockNotifiedAt not stored after crossing a custom threshold")
	}
}

// TestCheckLowStock_NotifyRunsOutsideTheLibraryLock pins the #1677 review fix:
// notify is called with no repo.Update in progress, so a slow/blocked Home
// Assistant call can no longer stall every other library write. The proof is
// that notify can itself complete a repo.Update without deadlocking.
func TestCheckLowStock_NotifyRunsOutsideTheLibraryLock(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 84))

	notified := false
	notify := func(string, int64) bool {
		done := make(chan error, 1)
		go func() { done <- repo.Update(func(*Library) error { return nil }) }()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("repo.Update inside notify: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("repo.Update inside notify deadlocked: notify ran while the library lock was held")
		}
		notified = true
		return true
	}

	if err := CheckLowStock(repo, noDoses, 10, DefaultLowStockThresholdG, notify); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if !notified {
		t.Fatal("notify was not called")
	}
	if _, ok := bagStamp(t, repo, 11); !ok {
		t.Fatal("lowStockNotifiedAt not stored after a delivered push")
	}
}
