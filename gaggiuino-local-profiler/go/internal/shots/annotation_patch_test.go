package shots

import (
	"fmt"
	"net/http"
	"sync"
	"testing"
)

// TestUpdateAnnotation_OrderedBySurvivesPatch is the #1273 regression: the
// order attribution is written by the server (orders' CompleteOrder), and a
// later client patch that never mentions orderedBy must not drop it.
func TestUpdateAnnotation_OrderedBySurvivesPatch(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	svc := NewService(repo)

	if _, err := repo.UpdateAnnotation(1, func(ann map[string]any) error {
		ann["orderedBy"] = map[string]any{"customer": "Ada", "orderId": "o1"}
		return nil
	}); err != nil {
		t.Fatalf("UpdateAnnotation: %v", err)
	}
	if _, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(4)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}

	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if _, ok := ann["orderedBy"]; !ok {
		t.Fatalf("patch dropped orderedBy: %#v", ann)
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("rating = %v, want 4", ann["rating"])
	}
}

// TestPatchAnnotation_ClientCannotChangeOrderedBy pins that orderedBy is
// server-owned: even a body that carries it is ignored.
func TestPatchAnnotation_ClientCannotChangeOrderedBy(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"orderedBy": map[string]any{"customer": "Ada"}})
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"orderedBy": map[string]any{"customer": "Mallory"}}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	ob, _ := ann["orderedBy"].(map[string]any)
	if ob["customer"] != "Ada" {
		t.Fatalf("client overwrote server-owned orderedBy: %#v", ann["orderedBy"])
	}
}

// TestPatchAnnotation_PartialPatchKeepsOtherFields is the core merge rule:
// keys the patch does not mention keep their stored value.
func TestPatchAnnotation_PartialPatchKeepsOtherFields(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{
		"notes": "tasty", "coffee": "Bean", "dose": float64(18),
	})
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(4)}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if ann["notes"] != "tasty" || ann["coffee"] != "Bean" || ann["dose"] != float64(18) {
		t.Fatalf("partial patch dropped stored fields: %#v", ann)
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("rating = %v, want 4", ann["rating"])
	}
}

// TestPatchAnnotation_ClearsWithEmptyStringAndNull: a key present as "" or
// JSON null overwrites (clears) the stored value.
func TestPatchAnnotation_ClearsWithEmptyStringAndNull(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{
		"notes": "tasty", "dose": float64(18),
	})
	svc := NewService(repo)

	if _, err := svc.PatchAnnotation(1, map[string]any{"notes": "", "dose": nil}); err != nil {
		t.Fatalf("PatchAnnotation: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if notes, ok := ann["notes"].(string); !ok || notes != "" {
		t.Fatalf("notes = %#v, want \"\"", ann["notes"])
	}
	if v, ok := ann["dose"]; !ok || v != nil {
		t.Fatalf("dose = %#v, want present and null", ann["dose"])
	}
}

// TestPatchAnnotation_InvalidMergeLeavesStoredUnchanged: validation runs on
// the merged result, and a failure must abort the write entirely.
func TestPatchAnnotation_InvalidMergeLeavesStoredUnchanged(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"rating": float64(4)})
	svc := NewService(repo)

	_, err := svc.PatchAnnotation(1, map[string]any{"rating": float64(99)})
	var verr *AnnotationValidationError
	if err == nil {
		t.Fatal("expected a validation error for rating 99")
	}
	if !isValidationError(err, &verr) {
		t.Fatalf("err = %T %v, want *AnnotationValidationError", err, err)
	}
	if len(verr.Issues) == 0 {
		t.Fatal("expected at least one validation issue")
	}
	ann, gerr := repo.GetAnnotation(1)
	if gerr != nil {
		t.Fatalf("GetAnnotation: %v", gerr)
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("invalid patch changed the stored annotation: %#v", ann)
	}
}

// TestPatchAnnotation_ConcurrentPatchesAllLand exercises the serialized
// read-modify-write: 20 patches to distinct keys of one shot must all be
// present afterwards (run with -race).
func TestPatchAnnotation_ConcurrentPatchesAllLand(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	svc := NewService(repo)

	const n = 20
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := svc.PatchAnnotation(1, map[string]any{fmt.Sprintf("k%d", i): float64(i)}); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent PatchAnnotation: %v", err)
	}

	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	for i := 0; i < n; i++ {
		key := fmt.Sprintf("k%d", i)
		if _, ok := ann[key]; !ok {
			t.Fatalf("concurrent patch for %q was lost: %#v", key, ann)
		}
	}
}

// TestUpsert_WithAnnotationReplacesWholeAnnotation keeps the restore/sync
// path's full-replace semantics: when a shot object carries a complete
// annotation, it overwrites whatever was stored.
func TestUpsert_WithAnnotationReplacesWholeAnnotation(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"a": float64(1), "b": float64(2)})

	if err := repo.Upsert(Shot{
		"id":         int64(1),
		"timestamp":  int64(2000),
		"annotation": map[string]any{"c": float64(3)},
		"datapoints": []any{},
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if len(ann) != 1 || ann["c"] != float64(3) {
		t.Fatalf("Upsert did not replace the whole annotation: %#v", ann)
	}
}

// TestAnnotate_PartialBodyKeepsStoredFields is the handler-level version of
// the merge rule: a POST body that carries only one field must not wipe the
// others.
func TestAnnotate_PartialBodyKeepsStoredFields(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, map[string]any{"notes": "keep", "coffee": "Bean"})

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(`{"rating":4}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if ann["notes"] != "keep" || ann["coffee"] != "Bean" {
		t.Fatalf("partial body wiped stored fields: %#v", ann)
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("rating = %v, want 4", ann["rating"])
	}
}

// isValidationError reports whether err is an *AnnotationValidationError,
// assigning it to target when so.
func isValidationError(err error, target **AnnotationValidationError) bool {
	verr, ok := err.(*AnnotationValidationError)
	if ok {
		*target = verr
	}
	return ok
}
