package library

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// seedMixLibrary writes two stock-tracked beans (ids 12 and 7) with no bags, the
// shape ComputeBeanRemaining reads bean-level stock_g from, plus one unrelated
// bean the mix must not touch.
func seedMixLibrary(t *testing.T, repo *Repository) {
	t.Helper()
	lib := Library{
		Beans: []Entity{
			{"id": float64(12), "name": "Bean A", "stock_g": float64(250)},
			{"id": float64(7), "name": "Bean B", "stock_g": float64(250)},
			{"id": float64(3), "name": "Untouched", "stock_g": float64(100)},
		},
	}
	if err := repo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

// mixAnnotationBody is a mixed shot's annotation: 10 g of bean 12 plus 8 g of
// bean 7. The top-level coffee/beanId name the primary bean (the largest share)
// and the top-level dose is the whole 18 g.
func mixAnnotationBody() map[string]any {
	mix := []any{
		map[string]any{"beanId": float64(12), "coffee": "Bean A", "grams": float64(10)},
		map[string]any{"beanId": float64(7), "coffee": "Bean B", "grams": float64(8)},
	}
	ann := map[string]any{"coffee": "Bean A", "beanId": float64(12), "dose": float64(18)}
	ann["beanMix"] = mix
	return ann
}

// TestBeanMixStock_ThroughAnnotatedDoses is the end-to-end stock path: a mix
// annotation is written through the real PatchAnnotation, read back by the real
// GetAnnotatedDoses, and each bean's remainingG drops by its own share only —
// the top-level 18 g dose is not counted on top (which would take 18 g off the
// primary bean as well).
func TestBeanMixStock_ThroughAnnotatedDoses(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	seedMixLibrary(t, repo)

	if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (7,1700000000,30,'V60','{}',1)`); err != nil {
		t.Fatalf("inserting shot: %v", err)
	}
	svc := shots.NewService(shots.NewRepository(sqlDB))
	if _, err := svc.PatchAnnotation(7, mixAnnotationBody()); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}

	doseRows, err := shots.NewRepository(sqlDB).GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(doseRows) != 2 {
		t.Fatalf("got %d dose rows, want one per mix part (2): %+v", len(doseRows), doseRows)
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	remaining := func(beanID int64) int64 {
		t.Helper()
		idx := findEntityIndex(lib.Beans, beanID)
		if idx == -1 {
			t.Fatalf("bean %d not found", beanID)
		}
		rem, ok := ComputeBeanRemaining(lib.Beans[idx], doseRows, lib.Beans)
		if !ok {
			t.Fatalf("bean %d has no remaining stock", beanID)
		}
		return rem
	}

	if got := remaining(12); got != 240 {
		t.Errorf("bean 12 remainingG = %d, want 240 (250 - its own 10 g share)", got)
	}
	if got := remaining(7); got != 242 {
		t.Errorf("bean 7 remainingG = %d, want 242 (250 - its own 8 g share)", got)
	}
	if got := remaining(3); got != 100 {
		t.Errorf("bean 3 remainingG = %d, want 100 (no mix part names it)", got)
	}
}

// TestBeanMixStock_SingleBeanUnchanged guards the non-mix path: a plain
// single-bean annotation still deducts its full dose from its own bean alone.
func TestBeanMixStock_SingleBeanUnchanged(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	seedMixLibrary(t, repo)

	if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (8,1700000000,30,'V60','{}',1)`); err != nil {
		t.Fatalf("inserting shot: %v", err)
	}
	svc := shots.NewService(shots.NewRepository(sqlDB))
	if _, err := svc.PatchAnnotation(8, map[string]any{"coffee": "Bean B", "beanId": float64(7), "dose": float64(18)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}

	doseRows, err := shots.NewRepository(sqlDB).GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(doseRows) != 1 {
		t.Fatalf("got %d dose rows for a single-bean shot, want 1: %+v", len(doseRows), doseRows)
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	for _, bean := range lib.Beans {
		rem, _ := ComputeBeanRemaining(bean, doseRows, lib.Beans)
		switch bean["name"] {
		case "Bean B":
			if rem != 232 {
				t.Errorf("Bean B remainingG = %d, want 232 (250 - 18)", rem)
			}
		case "Bean A":
			if rem != 250 {
				t.Errorf("Bean A remainingG = %d, want 250 (untouched)", rem)
			}
		}
	}
}
