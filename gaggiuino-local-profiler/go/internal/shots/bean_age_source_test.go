package shots

import (
	"errors"
	"testing"
)

// The stored bean age (#2025): PatchAnnotation derives it from the installed
// source so every client of the annotation endpoint stores the same number,
// and an age the source cannot resolve never disturbs the merged value.

// withBeanAgeSource installs a source for one test and removes it afterwards.
func withBeanAgeSource(t *testing.T, fn func() (func(map[string]any, int64) (int, bool), error)) {
	t.Helper()
	SetBeanAgeSource(fn)
	t.Cleanup(func() { SetBeanAgeSource(nil) })
}

// fixedBeanAgeSource installs a source that always reports days/ok and records
// the shot timestamp it was asked about.
func fixedBeanAgeSource(t *testing.T, days int, ok bool, gotSec *int64) {
	t.Helper()
	withBeanAgeSource(t, func() (func(map[string]any, int64) (int, bool), error) {
		return func(_ map[string]any, shotSec int64) (int, bool) {
			if gotSec != nil {
				*gotSec = shotSec
			}
			return days, ok
		}, nil
	})
}

func TestPatchAnnotation_StoresDerivedBeanAge(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	var gotSec int64
	fixedBeanAgeSource(t, 12, true, &gotSec)
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(4)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if ann["beanAgeDays"] != float64(12) {
		t.Fatalf("beanAgeDays = %v, want 12", ann["beanAgeDays"])
	}
	if gotSec != 1000 {
		t.Fatalf("age asked about timestamp %d, want the shot's own 1000", gotSec)
	}
}

func TestPatchAnnotation_DerivedAgeOverridesClientValue(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	fixedBeanAgeSource(t, 12, true, nil)
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"beanAgeDays": float64(30)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if ann["beanAgeDays"] != float64(12) {
		t.Fatalf("beanAgeDays = %v, want the derived 12", ann["beanAgeDays"])
	}
}

func TestPatchAnnotation_UnresolvedAgeKeepsStoredValue(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"beanAgeDays": float64(77)})
	fixedBeanAgeSource(t, 0, false, nil)
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(4)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if ann["beanAgeDays"] != float64(77) {
		t.Fatalf("beanAgeDays = %v, want the stored 77", ann["beanAgeDays"])
	}
}

func TestPatchAnnotation_UnresolvedAgeLetsClientClear(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"beanAgeDays": float64(77)})
	fixedBeanAgeSource(t, 0, false, nil)
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"beanAgeDays": nil}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if v, present := ann["beanAgeDays"]; present {
		t.Fatalf("beanAgeDays = %v, want the key deleted", v)
	}
}

func TestPatchAnnotation_FailingSourceDoesNotFailTheSave(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"beanAgeDays": float64(77)})
	withBeanAgeSource(t, func() (func(map[string]any, int64) (int, bool), error) {
		return nil, errors.New("library unavailable")
	})
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(4)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("rating = %v, want the patch saved anyway", ann["rating"])
	}
	if ann["beanAgeDays"] != float64(77) {
		t.Fatalf("beanAgeDays = %v, want the stored 77 untouched", ann["beanAgeDays"])
	}
}

func TestPatchAnnotation_NoSourceStoresNoAge(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	SetBeanAgeSource(nil)
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(4)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if v, present := ann["beanAgeDays"]; present {
		t.Fatalf("beanAgeDays = %v, want no key without a source", v)
	}
}
