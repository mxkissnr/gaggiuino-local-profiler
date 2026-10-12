package library

import (
	"testing"

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

	if err := CheckLowStock(repo, noDoses, 10, notify); err != nil {
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

	if err := CheckLowStock(repo, noDoses, 10, notify); err != nil {
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
	if err := CheckLowStock(repo, noDoses, 10, alwaysNotify); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if _, ok := bagStamp(t, repo, 11); !ok {
		t.Fatal("first bag not stamped")
	}

	// A new bag becomes current: the first is empty, the second carries stock.
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, 0), lowStockBag(12, 2_000, 84))
	var calls int
	if err := CheckLowStock(repo, noDoses, 10, func(string, int64) bool { calls++; return true }); err != nil {
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
	if err := CheckLowStock(repo, noDoses, 10, fail); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if _, ok := bagStamp(t, repo, 11); ok {
		t.Fatal("lowStockNotifiedAt stored despite the push failing")
	}
	if err := CheckLowStock(repo, noDoses, 10, fail); err != nil {
		t.Fatalf("second CheckLowStock: %v", err)
	}
	if calls != 2 {
		t.Fatalf("notify called %d times, want 2 (retried after the failed push)", calls)
	}
}

func TestCheckLowStock_AtThresholdNoNotify(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	saveLowStockBean(t, repo, lowStockBag(11, 1_000, lowStockThresholdG))

	var calls int
	if err := CheckLowStock(repo, noDoses, 10, func(string, int64) bool { calls++; return true }); err != nil {
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
	if err := CheckLowStock(repo, noDoses, 999, func(string, int64) bool { calls++; return true }); err != nil {
		t.Fatalf("CheckLowStock: %v", err)
	}
	if calls != 0 {
		t.Fatalf("notify called %d times for an unknown bean, want 0", calls)
	}
}
