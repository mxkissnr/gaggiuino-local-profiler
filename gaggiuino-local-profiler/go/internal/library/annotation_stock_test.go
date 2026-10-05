package library

import (
	"errors"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// seedStockLibrary writes the fixture the annotation-stock tests share: two
// milks, a bean with three frozen portions, and a second bean with a fourth
// portion (to prove the portion lookup spans beans).
func seedStockLibrary(t *testing.T, repo *Repository) {
	t.Helper()
	portion := func(id, count, remaining int64) map[string]any {
		return map[string]any{"id": float64(id), "frozenAt": float64(id), "portionCount": float64(count), "portionWeight_g": float64(18), "remainingCount": float64(remaining)}
	}
	bag := func(id int64, portions ...map[string]any) map[string]any {
		list := make([]any, 0, len(portions))
		for _, p := range portions {
			list = append(list, p)
		}
		return map[string]any{"id": float64(id), "frozenPortions": list}
	}
	bean := func(id int64, bags ...map[string]any) map[string]any {
		list := make([]any, 0, len(bags))
		for _, b := range bags {
			list = append(list, b)
		}
		return map[string]any{"id": float64(id), "bags": list}
	}
	lib := Library{
		Milks: []Entity{
			{"id": float64(1), "name": "Oat", "stockMl": float64(1000)},
			{"id": float64(2), "name": "Cow", "stockMl": float64(500)},
		},
		Beans: []Entity{
			bean(10, bag(11, portion(100, 20, 19), portion(200, 5, 5), portion(300, 2, 1))),
			bean(20, bag(21, portion(400, 3, 3))),
		},
	}
	if err := repo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

// stockMenu is the drink menu the tests resolve milk against.
func stockMenu() []Entity {
	return []Entity{
		{"id": "latte", "milkMl": float64(150)},
		{"id": "cappu", "milkMl": float64(100)},
		{"id": "espresso"},
	}
}

func milkStockOf(t *testing.T, repo *Repository, id int64) float64 {
	t.Helper()
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	idx := findMilkIndex(lib, id)
	if idx == -1 {
		t.Fatalf("milk %d not found", id)
	}
	stock, _ := jsParseFloat(lib.Milks[idx]["stockMl"])
	return stock
}

func portionStateOf(t *testing.T, repo *Repository, id int64) (int64, bool) {
	t.Helper()
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	for _, bean := range lib.Beans {
		p := findFrozenPortion(bean, id, false)
		if p == nil {
			continue
		}
		rc, ok := jsParseIntLoose(p["remainingCount"])
		if !ok {
			rc, _ = jsParseIntLoose(p["portionCount"])
		}
		_, thawed := p["thawedAt"]
		return rc, thawed
	}
	t.Fatalf("portion %d not found", id)
	return 0, false
}

// TestApplyAnnotationStock is the table of prev/next annotation pairs and the
// library stock they are expected to book.
func TestApplyAnnotationStock(t *testing.T) {
	menuCalls := 0
	menuFn := func() ([]Entity, error) {
		menuCalls++
		return stockMenu(), nil
	}

	latte := func() map[string]any {
		return map[string]any{"drinkType": "latte", "milkType": float64(1)}
	}

	cases := []struct {
		name      string
		seed      func(t *testing.T, repo *Repository)
		prev      map[string]any
		next      map[string]any
		wantCalls int
		check     func(t *testing.T, repo *Repository)
	}{
		{
			name:      "a fresh latte pulls milk",
			prev:      map[string]any{},
			next:      map[string]any{"drinkType": "latte", "milkType": float64(1)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 850 {
					t.Fatalf("milk1 = %v, want 850", got)
				}
			},
		},
		{
			name:      "b editing an unrelated field books nothing",
			prev:      latte(),
			next:      map[string]any{"drinkType": "latte", "milkType": float64(1), "rating": float64(5)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1000 {
					t.Fatalf("milk1 = %v, want 1000", got)
				}
			},
		},
		{
			name:      "c switching drink books back then deducts",
			prev:      latte(),
			next:      map[string]any{"drinkType": "cappu", "milkType": float64(1)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1050 {
					t.Fatalf("milk1 = %v, want 1050", got)
				}
			},
		},
		{
			name:      "d switching milk moves stock between milks",
			prev:      latte(),
			next:      map[string]any{"drinkType": "latte", "milkType": float64(2)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1150 {
					t.Fatalf("milk1 = %v, want 1150", got)
				}
				if got := milkStockOf(t, repo, 2); got != 350 {
					t.Fatalf("milk2 = %v, want 350", got)
				}
			},
		},
		{
			name:      "e clearing milk books back only",
			prev:      latte(),
			next:      map[string]any{"drinkType": "latte", "milkType": nil},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1150 {
					t.Fatalf("milk1 = %v, want 1150", got)
				}
			},
		},
		{
			name:      "f clearing drink books back only",
			prev:      latte(),
			next:      map[string]any{"drinkType": "", "milkType": float64(1)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1150 {
					t.Fatalf("milk1 = %v, want 1150", got)
				}
			},
		},
		{
			name:      "g drink without milk books nothing",
			prev:      map[string]any{},
			next:      map[string]any{"drinkType": "espresso", "milkType": float64(1)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1000 {
					t.Fatalf("milk1 = %v, want 1000", got)
				}
			},
		},
		{
			name: "h deduction floors at zero",
			seed: func(t *testing.T, repo *Repository) {
				seedStockLibrary(t, repo)
				if err := repo.Update(func(lib *Library) error {
					lib.Milks[findMilkIndex(*lib, 1)]["stockMl"] = float64(100)
					return nil
				}); err != nil {
					t.Fatalf("lowering milk stock: %v", err)
				}
			},
			prev:      map[string]any{},
			next:      map[string]any{"drinkType": "latte", "milkType": float64(1)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 0 {
					t.Fatalf("milk1 = %v, want 0", got)
				}
			},
		},
		{
			name:      "i unknown milk id is a no-op",
			prev:      map[string]any{},
			next:      map[string]any{"drinkType": "latte", "milkType": float64(99)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1000 {
					t.Fatalf("milk1 = %v, want 1000", got)
				}
				if got := milkStockOf(t, repo, 2); got != 500 {
					t.Fatalf("milk2 = %v, want 500", got)
				}
			},
		},
		{
			name:      "k attaching a frozen portion decrements it",
			prev:      map[string]any{},
			next:      map[string]any{"frozenPortionId": float64(200)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if rc, _ := portionStateOf(t, repo, 200); rc != 4 {
					t.Fatalf("portion 200 = %d, want 4", rc)
				}
			},
		},
		{
			name:      "l unchanged frozen portion is a no-op",
			prev:      map[string]any{"frozenPortionId": float64(100)},
			next:      map[string]any{"frozenPortionId": float64(100)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if rc, _ := portionStateOf(t, repo, 100); rc != 19 {
					t.Fatalf("portion 100 = %d, want 19", rc)
				}
			},
		},
		{
			name:      "m switching frozen portion credits then debits",
			prev:      map[string]any{"frozenPortionId": float64(100)},
			next:      map[string]any{"frozenPortionId": float64(200)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if rc, _ := portionStateOf(t, repo, 100); rc != 20 {
					t.Fatalf("portion 100 = %d, want 20", rc)
				}
				if rc, _ := portionStateOf(t, repo, 200); rc != 4 {
					t.Fatalf("portion 200 = %d, want 4", rc)
				}
			},
		},
		{
			name:      "n clearing frozen portion credits it",
			prev:      map[string]any{"frozenPortionId": float64(100)},
			next:      map[string]any{"frozenPortionId": nil},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if rc, _ := portionStateOf(t, repo, 100); rc != 20 {
					t.Fatalf("portion 100 = %d, want 20", rc)
				}
			},
		},
		{
			name:      "o credit is clamped to portionCount",
			prev:      map[string]any{"frozenPortionId": float64(200)},
			next:      map[string]any{},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if rc, _ := portionStateOf(t, repo, 200); rc != 5 {
					t.Fatalf("portion 200 = %d, want 5", rc)
				}
			},
		},
		{
			name:      "p reaching zero marks thawed, reattaching clears it",
			prev:      map[string]any{},
			next:      map[string]any{"frozenPortionId": float64(300)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				rc, thawed := portionStateOf(t, repo, 300)
				if rc != 0 || !thawed {
					t.Fatalf("portion 300 = %d thawed=%v, want 0 true", rc, thawed)
				}
				if err := ApplyAnnotationStock(repo, menuFn, map[string]any{"frozenPortionId": float64(300)}, map[string]any{}); err != nil {
					t.Fatalf("second ApplyAnnotationStock: %v", err)
				}
				rc, thawed = portionStateOf(t, repo, 300)
				if rc != 1 || thawed {
					t.Fatalf("portion 300 = %d thawed=%v, want 1 false", rc, thawed)
				}
			},
		},
		{
			name:      "q unknown frozen portion is a no-op",
			prev:      map[string]any{},
			next:      map[string]any{"frozenPortionId": float64(999)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 1000 {
					t.Fatalf("milk1 = %v, want 1000", got)
				}
			},
		},
		{
			name:      "r frozen portion in the second bean is found",
			prev:      map[string]any{},
			next:      map[string]any{"frozenPortionId": float64(400)},
			wantCalls: 0,
			check: func(t *testing.T, repo *Repository) {
				if rc, _ := portionStateOf(t, repo, 400); rc != 2 {
					t.Fatalf("portion 400 = %d, want 2", rc)
				}
			},
		},
		{
			name:      "s milk and portion book in one call",
			prev:      map[string]any{},
			next:      map[string]any{"drinkType": "latte", "milkType": float64(1), "frozenPortionId": float64(100)},
			wantCalls: 1,
			check: func(t *testing.T, repo *Repository) {
				if got := milkStockOf(t, repo, 1); got != 850 {
					t.Fatalf("milk1 = %v, want 850", got)
				}
				if rc, _ := portionStateOf(t, repo, 100); rc != 18 {
					t.Fatalf("portion 100 = %d, want 18", rc)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, repo, _ := newTestHandlers(t)
			if tc.seed != nil {
				tc.seed(t, repo)
			} else {
				seedStockLibrary(t, repo)
			}
			menuCalls = 0
			if err := ApplyAnnotationStock(repo, menuFn, tc.prev, tc.next); err != nil {
				t.Fatalf("ApplyAnnotationStock: %v", err)
			}
			if menuCalls != tc.wantCalls {
				t.Fatalf("menu calls = %d, want %d", menuCalls, tc.wantCalls)
			}
			tc.check(t, repo)
		})
	}
}

func TestApplyAnnotationStock_MenuErrorReturnsAndSkipsStock(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedStockLibrary(t, repo)
	menuErr := errors.New("menu boom")
	menuFn := func() ([]Entity, error) { return nil, menuErr }

	err := ApplyAnnotationStock(repo, menuFn, map[string]any{}, map[string]any{"drinkType": "latte", "milkType": float64(1)})
	if !errors.Is(err, menuErr) {
		t.Fatalf("err = %v, want menuErr", err)
	}
	if got := milkStockOf(t, repo, 1); got != 1000 {
		t.Fatalf("milk1 = %v, want 1000", got)
	}
}

func TestApplyAnnotationStock_MenuNotCalledWhenNothingChanged(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	seedStockLibrary(t, repo)
	calls := 0
	menuFn := func() ([]Entity, error) {
		calls++
		return nil, errors.New("menu boom")
	}

	if err := ApplyAnnotationStock(repo, menuFn, map[string]any{}, map[string]any{"rating": float64(5)}); err != nil {
		t.Fatalf("ApplyAnnotationStock: %v", err)
	}
	if calls != 0 {
		t.Fatalf("menu calls = %d, want 0", calls)
	}
}

// TestApplyAnnotationStock_ThroughPatchAnnotation is the end-to-end path: the
// hook is installed on the shots package and driven through a real
// PatchAnnotation, exactly as cmd/server wires it.
func TestApplyAnnotationStock_ThroughPatchAnnotation(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	seedStockLibrary(t, repo)
	menuFn := func() ([]Entity, error) { return stockMenu(), nil }
	shots.SetAnnotationStockHook(func(prev, next map[string]any) error {
		return ApplyAnnotationStock(repo, menuFn, prev, next)
	})
	t.Cleanup(func() { shots.SetAnnotationStockHook(nil) })

	if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (7,1700000000,30,'V60','{}',1)`); err != nil {
		t.Fatalf("inserting shot: %v", err)
	}
	svc := shots.NewService(shots.NewRepository(sqlDB))

	if _, err := svc.PatchAnnotation(7, map[string]any{"drinkType": "latte", "milkType": float64(1)}); err != nil {
		t.Fatalf("PatchAnnotation (latte): %v", err)
	}
	if got := milkStockOf(t, repo, 1); got != 850 {
		t.Fatalf("milk1 after latte = %v, want 850", got)
	}
	if _, err := svc.PatchAnnotation(7, map[string]any{"rating": float64(5)}); err != nil {
		t.Fatalf("PatchAnnotation (rating): %v", err)
	}
	if got := milkStockOf(t, repo, 1); got != 850 {
		t.Fatalf("milk1 after rating = %v, want 850", got)
	}
	if _, err := svc.PatchAnnotation(7, map[string]any{"milkType": nil}); err != nil {
		t.Fatalf("PatchAnnotation (clear milk): %v", err)
	}
	if got := milkStockOf(t, repo, 1); got != 1000 {
		t.Fatalf("milk1 after clearing milk = %v, want 1000", got)
	}
}
