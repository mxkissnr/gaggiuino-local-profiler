package library

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// These tests cover Repository.Update, the write lock that serialises the
// library's read-modify-write cycle (part of #1199). They build on
// newTestHandlers' fixture (helpers_test.go), which opens a real on-disk
// SQLite DB through db.Open — a file-backed database with a pooled set of
// connections (WAL + busy_timeout), not a single shared :memory: handle —
// so the goroutines below genuinely race at the Go level rather than being
// accidentally serialised by one pooled connection.

func seedMilkAndBean(t *testing.T, repo *Repository) {
	t.Helper()
	if err := repo.Update(func(lib *Library) error {
		lib.Milks = append(lib.Milks, Entity{"id": int64(1), "name": "Whole Milk", "stockMl": float64(1000)})
		lib.Beans = append(lib.Beans, Entity{"id": int64(1), "name": "Old Bean"})
		return nil
	}); err != nil {
		t.Fatalf("seeding library: %v", err)
	}
}

func milkStockMl(t *testing.T, repo *Repository) float64 {
	t.Helper()
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Milks) != 1 {
		t.Fatalf("milks = %d, want 1", len(lib.Milks))
	}
	stock, _ := jsParseFloat(lib.Milks[0]["stockMl"])
	return stock
}

// TestUpdate_ConcurrentWritersLoseNothing is the #1199 regression test: with
// the old unguarded GetLibrary/SaveLibrary pattern, 50 concurrent
// DeductMilkByName calls each read the same 1000 ml stock and save it back,
// so only a few deductions survive. Update serialises them, so every one
// lands and the final stock is exactly 950.
func TestUpdate_ConcurrentWritersLoseNothing(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedMilkAndBean(t, repo)

	const writers = 50
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, found, err := DeductMilkByName(repo, "Whole Milk", 1)
			if err != nil {
				errs <- err
				return
			}
			if !found {
				errs <- fmt.Errorf("milk not found")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("DeductMilkByName: %v", err)
	}

	if got := milkStockMl(t, repo); got != 950 {
		t.Fatalf("stockMl after 50 concurrent 1 ml deductions = %v, want 950 (lost updates)", got)
	}
}

// TestUpdate_ConcurrentMilkAndBeanEditsBothSurvive mixes both kinds of
// writer: concurrent milk deductions and concurrent bean renames. Each
// Update saves the whole blob, so before #1199 one writer's save would flush
// the other's change; both must survive.
func TestUpdate_ConcurrentMilkAndBeanEditsBothSurvive(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedMilkAndBean(t, repo)

	const deductions = 25
	const renames = 25
	var wg sync.WaitGroup
	errs := make(chan error, deductions+renames)
	for i := 0; i < deductions; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := DeductMilkByName(repo, "Whole Milk", 1); err != nil {
				errs <- err
			}
		}()
	}
	for i := 0; i < renames; i++ {
		name := fmt.Sprintf("Renamed %d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := repo.Update(func(lib *Library) error {
				for j, bean := range lib.Beans {
					if id, ok := idOf(bean, "id"); ok && id == 1 {
						bean["name"] = name
						lib.Beans[j] = bean
					}
				}
				return nil
			})
			if err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent writer: %v", err)
	}

	if got := milkStockMl(t, repo); got != 1000-deductions {
		t.Fatalf("stockMl = %v, want %d — bean renames must not lose milk deductions", got, 1000-deductions)
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	name, _ := lib.Beans[0]["name"].(string)
	if name == "Old Bean" {
		t.Fatalf("bean name = %q — a milk deduction's save overwrote the rename (lost update)", name)
	}
	if !strings.HasPrefix(name, "Renamed ") {
		t.Fatalf("bean name = %q, want one of the concurrent \"Renamed N\" values", name)
	}
}

// TestUpdate_CallbackErrorSavesNothing: an error from the callback aborts the
// write, so the in-memory mutation it made must not reach the DB and the
// error must come back unchanged.
func TestUpdate_CallbackErrorSavesNothing(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedMilkAndBean(t, repo)

	sentinel := errors.New("boom")
	err := repo.Update(func(lib *Library) error {
		lib.Milks[0]["stockMl"] = float64(5)
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("Update error = %v, want the callback's sentinel", err)
	}
	if got := milkStockMl(t, repo); got != 1000 {
		t.Fatalf("stockMl = %v after a failed Update, want 1000 (nothing saved)", got)
	}
}

// TestUpdate_SkipSentinelSavesNothing: ErrSkipSave aborts the write the same
// way but is returned so callers can treat it as their own no-op.
func TestUpdate_SkipSentinelSavesNothing(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedMilkAndBean(t, repo)

	err := repo.Update(func(lib *Library) error {
		lib.Milks[0]["stockMl"] = float64(5)
		return ErrSkipSave
	})
	if !errors.Is(err, ErrSkipSave) {
		t.Fatalf("Update error = %v, want ErrSkipSave", err)
	}
	if got := milkStockMl(t, repo); got != 1000 {
		t.Fatalf("stockMl = %v after a skipped Update, want 1000 (nothing saved)", got)
	}
}
