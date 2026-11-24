package shots

import (
	"encoding/json"
	"testing"
)

// TestRecomputeStoredBeanAges_RewritesDifferingValue is the #2100 core case: a
// shot annotated before the shared rule stores the old plain bag age while the
// rule resolves a different one, and the pass rewrites only that key.
func TestRecomputeStoredBeanAges_RewritesDifferingValue(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, map[string]any{
		"coffee":      "A",
		"rating":      float64(4),
		"notes":       "x",
		"beanAgeDays": float64(115),
	})

	var seen []int64
	age := func(ann map[string]any, shotSec int64) (int, bool) {
		seen = append(seen, shotSec)
		return 21, true
	}

	changed, err := repo.RecomputeStoredBeanAges(age)
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 1 {
		t.Fatalf("changed = %d, want 1", changed)
	}
	if len(seen) != 1 || seen[0] != 1_700_000_000 {
		t.Fatalf("age called with %v, want the shot timestamp", seen)
	}

	var raw string
	if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, 1).Scan(&raw); err != nil {
		t.Fatalf("reading annotation: %v", err)
	}
	var ann map[string]any
	if err := json.Unmarshal([]byte(raw), &ann); err != nil {
		t.Fatalf("decoding annotation: %v", err)
	}
	if got, ok := ann["beanAgeDays"].(float64); !ok || got != 21 {
		t.Fatalf("beanAgeDays = %v, want 21", ann["beanAgeDays"])
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("rating = %v, want 4", ann["rating"])
	}
	if ann["notes"] != "x" {
		t.Fatalf("notes = %v, want x", ann["notes"])
	}
	if ann["coffee"] != "A" {
		t.Fatalf("coffee = %v, want A", ann["coffee"])
	}
}

// TestRecomputeStoredBeanAges_UnresolvedKeepsStored pins the #1788 fallback: an
// age that no longer resolves leaves the stored value (and a missing key)
// exactly as it was.
func TestRecomputeStoredBeanAges_UnresolvedKeepsStored(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, map[string]any{
		"coffee":      "A",
		"beanAgeDays": float64(77),
	})
	insertShot(t, sqlDB, 2, 1_700_000_001, nil, "", nil, map[string]any{"coffee": "B"})

	before := map[int64]string{}
	for _, id := range []int64{1, 2} {
		var raw string
		if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, id).Scan(&raw); err != nil {
			t.Fatalf("reading annotation %d: %v", id, err)
		}
		before[id] = raw
	}

	changed, err := repo.RecomputeStoredBeanAges(func(map[string]any, int64) (int, bool) { return 0, false })
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 0 {
		t.Fatalf("changed = %d, want 0", changed)
	}
	for _, id := range []int64{1, 2} {
		var raw string
		if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, id).Scan(&raw); err != nil {
			t.Fatalf("reading annotation %d: %v", id, err)
		}
		if raw != before[id] {
			t.Fatalf("annotation %d changed: %q -> %q", id, before[id], raw)
		}
	}
	var ann map[string]any
	if err := json.Unmarshal([]byte(before[2]), &ann); err != nil {
		t.Fatalf("decoding annotation 2: %v", err)
	}
	if _, ok := ann["beanAgeDays"]; ok {
		t.Fatalf("annotation 2 gained a beanAgeDays key: %v", ann)
	}
}

// TestRecomputeStoredBeanAges_AddsMissingKey mirrors PatchAnnotation: a
// resolving age is stored even when the annotation had no key at all.
func TestRecomputeStoredBeanAges_AddsMissingKey(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, map[string]any{"coffee": "A"})

	changed, err := repo.RecomputeStoredBeanAges(func(map[string]any, int64) (int, bool) { return 33, true })
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 1 {
		t.Fatalf("changed = %d, want 1", changed)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if got, ok := ann["beanAgeDays"].(float64); !ok || got != 33 {
		t.Fatalf("beanAgeDays = %v, want 33", ann["beanAgeDays"])
	}
}

// TestRecomputeStoredBeanAges_IncludesTrashedShots: a trashed shot keeps the
// right value for when it is restored, so the pass does not filter it out.
func TestRecomputeStoredBeanAges_IncludesTrashedShots(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, map[string]any{
		"coffee":      "A",
		"beanAgeDays": float64(115),
	})
	insertTrashEntry(t, sqlDB, 1, 1_700_000_500)

	changed, err := repo.RecomputeStoredBeanAges(func(map[string]any, int64) (int, bool) { return 21, true })
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 1 {
		t.Fatalf("changed = %d, want 1", changed)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if got, ok := ann["beanAgeDays"].(float64); !ok || got != 21 {
		t.Fatalf("beanAgeDays = %v, want 21", ann["beanAgeDays"])
	}
}

// TestRecomputeStoredBeanAges_SkipsInvalidJSON: one damaged annotation is
// skipped and left as it was, while the rest of the pass still runs.
func TestRecomputeStoredBeanAges_SkipsInvalidJSON(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, nil)
	if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, 'not json')`, 1); err != nil {
		t.Fatalf("inserting invalid annotation: %v", err)
	}
	insertShot(t, sqlDB, 2, 1_700_000_001, nil, "", nil, map[string]any{
		"coffee":      "B",
		"beanAgeDays": float64(115),
	})

	changed, err := repo.RecomputeStoredBeanAges(func(map[string]any, int64) (int, bool) { return 21, true })
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 1 {
		t.Fatalf("changed = %d, want 1", changed)
	}

	var raw string
	if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, 1).Scan(&raw); err != nil {
		t.Fatalf("reading annotation 1: %v", err)
	}
	if raw != "not json" {
		t.Fatalf("invalid annotation changed: %q", raw)
	}

	ann, err := repo.GetAnnotation(2)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if got, ok := ann["beanAgeDays"].(float64); !ok || got != 21 {
		t.Fatalf("beanAgeDays = %v, want 21", ann["beanAgeDays"])
	}
}

// TestRecomputeStoredBeanAges_SkipsZeroTimestamp: a shot with no usable
// timestamp is never handed to the age function.
func TestRecomputeStoredBeanAges_SkipsZeroTimestamp(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 0, nil, "", nil, map[string]any{
		"coffee":      "A",
		"beanAgeDays": float64(115),
	})

	called := false
	changed, err := repo.RecomputeStoredBeanAges(func(map[string]any, int64) (int, bool) {
		called = true
		return 21, true
	})
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 0 {
		t.Fatalf("changed = %d, want 0", changed)
	}
	if called {
		t.Fatal("age function called for a zero timestamp")
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if got, ok := ann["beanAgeDays"].(float64); !ok || got != 115 {
		t.Fatalf("beanAgeDays = %v, want the stored 115", ann["beanAgeDays"])
	}
}

// TestRecomputeStoredBeanAges_Idempotent: a second pass changes nothing and
// leaves every row byte-identical.
func TestRecomputeStoredBeanAges_Idempotent(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, map[string]any{
		"coffee":      "A",
		"beanAgeDays": float64(115),
	})
	insertShot(t, sqlDB, 2, 1_700_000_001, nil, "", nil, map[string]any{"coffee": "B"})

	age := func(map[string]any, int64) (int, bool) { return 21, true }
	if _, err := repo.RecomputeStoredBeanAges(age); err != nil {
		t.Fatalf("first RecomputeStoredBeanAges: %v", err)
	}

	after := map[int64]string{}
	for _, id := range []int64{1, 2} {
		var raw string
		if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, id).Scan(&raw); err != nil {
			t.Fatalf("reading annotation %d: %v", id, err)
		}
		after[id] = raw
	}

	changed, err := repo.RecomputeStoredBeanAges(age)
	if err != nil {
		t.Fatalf("second RecomputeStoredBeanAges: %v", err)
	}
	if changed != 0 {
		t.Fatalf("second pass changed = %d, want 0", changed)
	}
	for _, id := range []int64{1, 2} {
		var raw string
		if err := sqlDB.QueryRow(`SELECT data FROM annotations WHERE shot_id = ?`, id).Scan(&raw); err != nil {
			t.Fatalf("reading annotation %d: %v", id, err)
		}
		if raw != after[id] {
			t.Fatalf("annotation %d changed on the second pass: %q -> %q", id, after[id], raw)
		}
	}
}

// TestRecomputeStoredBeanAges_NilAge pins that a nil age touches nothing.
func TestRecomputeStoredBeanAges_NilAge(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1_700_000_000, nil, "", nil, map[string]any{
		"coffee":      "A",
		"beanAgeDays": float64(115),
	})

	changed, err := repo.RecomputeStoredBeanAges(nil)
	if err != nil {
		t.Fatalf("RecomputeStoredBeanAges: %v", err)
	}
	if changed != 0 {
		t.Fatalf("changed = %d, want 0", changed)
	}
	ann, err := repo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if got, ok := ann["beanAgeDays"].(float64); !ok || got != 115 {
		t.Fatalf("beanAgeDays = %v, want the stored 115", ann["beanAgeDays"])
	}
}
