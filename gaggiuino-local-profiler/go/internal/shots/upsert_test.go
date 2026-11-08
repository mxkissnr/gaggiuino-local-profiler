package shots

import (
	"encoding/json"
	"testing"
)

// TestUpsert_PreservesAnnotationAndTrash is the #1150 regression: a sync
// re-upserts a shot that already exists locally (its payload carries no
// `annotation` key). The old INSERT OR REPLACE deleted the row first, and
// because annotations.shot_id cascades on delete, the annotation vanished.
// The shot's stored data must still update, the annotation must survive and
// the trash entry must remain.
func TestUpsert_PreservesAnnotationAndTrash(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

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

	if _, ok := trashEntry(t, sqlDB, 5); !ok {
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

// TestShotInsertArgs_ImageCrop pins the restore/import half of the crop
// invariant: an `imageCrop` only survives into the stored blob when it is a
// complete, valid rectangle AND its photo extension is one the app accepts.
// A malformed rectangle or an orphaned crop (no image) would otherwise enter
// the DB as data no route can honour.
func TestShotInsertArgs_ImageCrop(t *testing.T) {
	validCrop := map[string]any{"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.6}
	cases := []struct {
		name string
		shot Shot
		want bool
	}{
		{"valid crop with image", Shot{"id": int64(1), "image": "jpg", "imageCrop": validCrop}, true},
		{"valid crop, unknown image", Shot{"id": int64(1), "image": "jpeg", "imageCrop": validCrop}, false},
		{"valid crop, no image", Shot{"id": int64(1), "imageCrop": validCrop}, false},
		{"crop missing a side", Shot{"id": int64(1), "image": "jpg", "imageCrop": map[string]any{"x": 0.1, "y": 0.2, "w": 0.5}}, false},
		{"crop out of range", Shot{"id": int64(1), "image": "jpg", "imageCrop": map[string]any{"x": 0.5, "y": 0.5, "w": 0.9, "h": 0.9}}, false},
		{"crop not an object", Shot{"id": int64(1), "image": "jpg", "imageCrop": "0,0,1,1"}, false},
		{"crop with a non-number", Shot{"id": int64(1), "image": "jpg", "imageCrop": map[string]any{"x": "0", "y": 0, "w": 1, "h": 1}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row, err := shotInsertArgs(tc.shot)
			if err != nil {
				t.Fatalf("shotInsertArgs: %v", err)
			}
			var stored map[string]any
			if err := json.Unmarshal([]byte(row.data), &stored); err != nil {
				t.Fatalf("decoding stored data %q: %v", row.data, err)
			}
			got, ok := stored["imageCrop"]
			if ok != tc.want {
				t.Fatalf("imageCrop present = %v, want %v (data=%s)", ok, tc.want, row.data)
			}
			if !tc.want {
				return
			}
			crop, ok := got.(map[string]any)
			if !ok {
				t.Fatalf("imageCrop = %#v, want an object", got)
			}
			for _, key := range []string{"x", "y", "w", "h"} {
				if crop[key] != validCrop[key] {
					t.Fatalf("imageCrop[%q] = %#v, want %#v", key, crop[key], validCrop[key])
				}
			}
		})
	}
}
