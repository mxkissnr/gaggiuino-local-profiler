package shots

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"testing"
)

// ── FindTrashed (#901 finding 2: was a TrashIDs()+FindByID-per-id N+1) ────

func TestFindTrashed_MultipleEntriesOrderedAndHydrated(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 3, 3000, &dur, "V60", nil, nil)

	if err := repo.MoveToTrash(3); err != nil {
		t.Fatalf("MoveToTrash(3): %v", err)
	}
	if err := repo.MoveToTrash(1); err != nil {
		t.Fatalf("MoveToTrash(1): %v", err)
	}

	trashed, err := repo.FindTrashed()
	if err != nil {
		t.Fatalf("FindTrashed: %v", err)
	}
	if len(trashed) != 2 {
		t.Fatalf("expected 2 trashed shots, got %d: %+v", len(trashed), trashed)
	}
	// Ordered by shot id ascending regardless of the order shots were
	// trashed in (3 was trashed before 1).
	if trashed[0].id() != 1 || trashed[1].id() != 3 {
		t.Errorf("expected trashed shots ordered [1,3], got [%d,%d]", trashed[0].id(), trashed[1].id())
	}
	for _, shot := range trashed {
		if shot["timestamp"] == nil {
			t.Errorf("shot %d: expected hydrated fields (timestamp) from the joined query", shot.id())
		}
	}
}

// TestFindTrashed_SkipsOrphanTrashEntry pins that a trash row whose shots row
// is somehow already gone (trash has no FK to shots — see internal/db/db.go)
// is silently skipped, not returned as a nil/zero entry or an error.
func TestFindTrashed_SkipsOrphanTrashEntry(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	if err := repo.MoveToTrash(1); err != nil {
		t.Fatalf("MoveToTrash(1): %v", err)
	}
	// Orphan trash entry: no matching shots row.
	if err := repo.MoveToTrash(999); err != nil {
		t.Fatalf("MoveToTrash(999): %v", err)
	}

	trashed, err := repo.FindTrashed()
	if err != nil {
		t.Fatalf("FindTrashed: %v", err)
	}
	if len(trashed) != 1 || trashed[0].id() != 1 {
		t.Fatalf("expected only shot 1 (orphan trash entry 999 skipped), got %+v", trashed)
	}
}

// ── AppendToBlocklist (#901 finding 1: was a GetBlocklist + whole-list
// rewrite, racy under concurrent deletes) ────────────────────

// TestDelete_ConcurrentDeletesAllLandInBlocklist reproduces the race
// against the actual HTTP path: N goroutines each permanently delete a
// distinct shot concurrently. Before the fix, the delete handler's
// GetBlocklist-then-rewrite round trip let two overlapping requests each
// read the same blocklist snapshot and then have the later whole-list write
// (a blanket DELETE+re-INSERT) clobber the earlier one's
// addition, silently dropping an id that had already been permanently
// deleted. AppendToBlocklist's single INSERT OR IGNORE has no read step, so
// every concurrent delete's id must end up present exactly once.
func TestDelete_ConcurrentDeletesAllLandInBlocklist(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	const n = 25
	dur := int64(300)
	for i := int64(1); i <= n; i++ {
		insertShot(t, sqlDB, i, i*1000, &dur, "V60", nil, nil)
	}

	var wg sync.WaitGroup
	for i := int64(1); i <= n; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			rec := doJSON(t, mux, http.MethodPost, fmt.Sprintf("/api/shots/%d/delete", id), nil)
			if rec.Code != http.StatusOK {
				t.Errorf("shot %d: status = %d, want 200; body=%s", id, rec.Code, rec.Body.String())
			}
		}(i)
	}
	wg.Wait()

	blocklist, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	seen := make(map[string]bool, len(blocklist))
	for _, v := range blocklist {
		if seen[v] {
			t.Errorf("blocklist has duplicate entry %q", v)
		}
		seen[v] = true
	}
	for i := int64(1); i <= n; i++ {
		idStr := strconv.FormatInt(i, 10)
		if !seen[idStr] {
			t.Errorf("blocklist missing deleted id %d — lost update", i)
		}
	}
	if len(seen) != n {
		t.Fatalf("expected all %d deleted ids in the blocklist, got %d: %+v", n, len(seen), blocklist)
	}
}

// TestUpsert_DropsUnknownImageExtension pins that an `image` value read back
// from sync/restore/import is only stored when it is a whitelisted
// extension. Delete and move build paths from it, so anything else is
// dropped at the single write point.
func TestUpsert_DropsUnknownImageExtension(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	cases := []struct {
		name  string
		image any
		want  bool
	}{
		{"parent traversal", "../x", false},
		{"separator", "x/jpg", false},
		{"unknown extension", "jpeg", false},
		{"non-string", float64(1), false},
		{"known extension", "png", true},
	}
	for i, tc := range cases {
		id := int64(i + 1)
		if err := repo.Upsert(Shot{"id": id, "timestamp": id * 1000, "image": tc.image}); err != nil {
			t.Fatalf("Upsert(%q): %v", tc.name, err)
		}
		var data string
		if err := sqlDB.QueryRow(`SELECT data FROM shots WHERE id = ?`, id).Scan(&data); err != nil {
			t.Fatalf("reading shot %d data: %v", id, err)
		}
		var stored map[string]any
		if err := json.Unmarshal([]byte(data), &stored); err != nil {
			t.Fatalf("decoding shot %d data: %v", id, err)
		}
		got, ok := stored["image"]
		if ok != tc.want {
			t.Fatalf("%s: image key present = %v, want %v (data=%s)", tc.name, ok, tc.want, data)
		}
		if tc.want && got != tc.image {
			t.Fatalf("%s: image = %v, want %v", tc.name, got, tc.image)
		}
	}
}
