package shots

import "testing"

// TestUpsert_PreservesAnnotationAndTrash is the #1150 regression: a sync
// re-upserts a shot that already exists locally (its payload carries no
// `annotation` key). The old INSERT OR REPLACE deleted the row first, and
// because annotations.shot_id cascades on delete, the annotation vanished.
// The shot's stored data must still update, the annotation must survive and
// the trash entry must remain.
func TestUpsert_PreservesAnnotationAndTrash(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	if err := repo.Upsert(Shot{"id": int64(5), "timestamp": int64(1000), "datapoints": []any{}}); err != nil {
		t.Fatalf("Upsert(5): %v", err)
	}
	if err := repo.SaveAnnotation(5, map[string]any{"rating": float64(8), "notes": "tasty"}); err != nil {
		t.Fatalf("SaveAnnotation(5): %v", err)
	}
	if err := repo.MoveToTrash(5); err != nil {
		t.Fatalf("MoveToTrash(5): %v", err)
	}

	// A later sync re-fetches shot 5 without an `annotation` key, exactly the
	// shape syncDefaultMachineShots stores.
	if err := repo.Upsert(Shot{"id": int64(5), "timestamp": int64(2000), "profileName": "Updated", "datapoints": []any{}}); err != nil {
		t.Fatalf("Upsert(5) again: %v", err)
	}

	ann, err := repo.GetAnnotation(5)
	if err != nil {
		t.Fatalf("GetAnnotation(5): %v", err)
	}
	if ann["rating"] != float64(8) || ann["notes"] != "tasty" {
		t.Fatalf("annotation after re-upsert = %#v, want rating 8 / notes tasty", ann)
	}

	if _, ok, err := repo.GetTrashEntry(5); err != nil {
		t.Fatalf("GetTrashEntry(5): %v", err)
	} else if !ok {
		t.Fatalf("trash entry for shot 5 was deleted by the re-upsert")
	}

	got, err := repo.FindByID(5)
	if err != nil {
		t.Fatalf("FindByID(5): %v", err)
	}
	if got == nil {
		t.Fatalf("shot 5 missing after re-upsert")
	}
	if got["timestamp"] != int64(2000) {
		t.Fatalf("shot 5 timestamp = %v, want 2000 (data should still update)", got["timestamp"])
	}
}

// TestMaxNativeShotID_IncludesTrashedHighest is the other half of #1150:
// when the newest local shot is in the trash it must still count toward the
// local max, or the sync starting point sits one below it and that shot is
// downloaded again on every sync.
func TestMaxNativeShotID_IncludesTrashedHighest(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	for i := int64(1); i <= 3; i++ {
		if err := repo.Upsert(Shot{"id": i, "timestamp": i * 1000, "datapoints": []any{}}); err != nil {
			t.Fatalf("Upsert(%d): %v", i, err)
		}
	}
	if err := repo.MoveToTrash(3); err != nil {
		t.Fatalf("MoveToTrash(3): %v", err)
	}

	max, err := repo.MaxNativeShotID(1)
	if err != nil {
		t.Fatalf("MaxNativeShotID(1): %v", err)
	}
	if max != 3 {
		t.Fatalf("MaxNativeShotID(1) = %d, want 3 (trashed highest shot must count)", max)
	}
}
