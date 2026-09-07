package shots

import (
	"errors"
	"testing"
)

func TestForEachShotForBackup_OrderAndBatching(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	// Insert deliberately out of insertion order; two share a timestamp so
	// the id tiebreak is exercised.
	insertShot(t, sqlDB, 5, 3000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 9, 2000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 4, 2000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 1, 500, &dur, "V60", nil, nil)

	want := []int64{1, 2, 4, 9, 5} // (ts,id) ASC: (500,1)(1000,2)(2000,4)(2000,9)(3000,5)

	for _, batch := range []int{1, 2, 3, 100} {
		var got []int64
		if err := repo.ForEachShotForBackup(batch, func(s Shot) error {
			got = append(got, s.id())
			return nil
		}); err != nil {
			t.Fatalf("batch=%d: %v", batch, err)
		}
		if len(got) != len(want) {
			t.Fatalf("batch=%d: got %v, want %v", batch, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("batch=%d: got %v, want %v", batch, got, want)
			}
		}
	}
}

func TestForEachShotForBackup_MatchesFindAllOrder(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	for i := int64(1); i <= 20; i++ {
		insertShot(t, sqlDB, i, (21-i)*100, &dur, "V60", nil, nil)
	}
	all, err := repo.FindAll()
	if err != nil {
		t.Fatal(err)
	}
	var streamed []int64
	if err := repo.ForEachShotForBackup(7, func(s Shot) error {
		streamed = append(streamed, s.id())
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(streamed) != len(all) {
		t.Fatalf("streamed %d shots, FindAll returned %d", len(streamed), len(all))
	}
	for i := range all {
		if all[i].id() != streamed[i] {
			t.Fatalf("order mismatch at %d: FindAll=%d stream=%d", i, all[i].id(), streamed[i])
		}
	}
}

func TestTrashMap(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 3, 3000, &dur, "V60", nil, nil)

	if err := repo.SetTrashEntry(1, 111); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetTrashEntry(3, 333); err != nil {
		t.Fatal(err)
	}
	// Orphan trash row (no shots row) must be excluded by the JOIN.
	if err := repo.SetTrashEntry(999, 999); err != nil {
		t.Fatal(err)
	}

	m, err := repo.TrashMap()
	if err != nil {
		t.Fatalf("TrashMap: %v", err)
	}
	if len(m) != 2 || m["1"] != 111 || m["3"] != 333 {
		t.Fatalf("TrashMap = %+v; want {1:111, 3:333}", m)
	}
}

// TestRestoreShots_RollbackOnStreamError feeds a shot stream that fails
// part-way through; the whole restore tx (wipe + the shots written so far)
// must roll back, leaving the pre-restore shots table untouched.
func TestRestoreShots_RollbackOnStreamError(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "Pre A", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "Pre B", nil, nil)
	insertShot(t, sqlDB, 3, 3000, &dur, "Pre C", nil, nil)

	boom := errors.New("boom mid-stream")
	err := repo.RestoreShots(RestoreInput{
		Shots: func(yield func(Shot) error) error {
			if err := yield(Shot{"id": float64(100), "timestamp": float64(9000), "profileName": "New"}); err != nil {
				return err
			}
			if err := yield(Shot{"id": float64(101), "timestamp": float64(9100), "profileName": "New"}); err != nil {
				return err
			}
			return boom
		},
		Blocklist: []string{"42"},
	})
	if !errors.Is(err, boom) {
		t.Fatalf("RestoreShots err = %v; want the mid-stream error", err)
	}

	n, err := repo.Count()
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("shots count after rolled-back restore = %d; want 3 (pre-restore rows intact)", n)
	}
	for _, id := range []int64{1, 2, 3} {
		s, err := repo.FindByID(id)
		if err != nil || s == nil {
			t.Fatalf("pre-restore shot %d missing after rollback: err=%v", id, err)
		}
	}
	if s, _ := repo.FindByID(100); s != nil {
		t.Fatalf("half-written shot 100 survived the rollback")
	}
	bl, _ := repo.GetBlocklist()
	if len(bl) != 0 {
		t.Fatalf("blocklist mutated by a rolled-back restore: %v", bl)
	}
}

// TestRestoreShots_CommitsAllSideData is the happy path: one tx writes
// shots + annotations + trash (filtered to restored ids) + blocklist +
// library.
func TestRestoreShots_CommitsAllSideData(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	dur := int64(300)
	insertShot(t, sqlDB, 7, 1, &dur, "old", nil, nil) // wiped by the restore

	err := repo.RestoreShots(RestoreInput{
		Shots: func(yield func(Shot) error) error {
			for _, id := range []float64{10, 11} {
				if err := yield(Shot{"id": id, "timestamp": id * 1000, "profileName": "P"}); err != nil {
					return err
				}
			}
			return nil
		},
		Annotations: map[string]map[string]any{"10": {"coffee": "Bean X"}},
		Trash:       map[string]int64{"11": 555, "999": 1}, // 999 not restored -> skipped
		Blocklist:   []string{"1", "2"},
		LibraryJSON: []byte(`{"beans":[{"id":1,"name":"B"}]}`),
	})
	if err != nil {
		t.Fatalf("RestoreShots: %v", err)
	}

	if s, _ := repo.FindByID(7); s != nil {
		t.Errorf("pre-restore shot 7 not wiped")
	}
	s10, _ := repo.FindByID(10)
	if s10 == nil {
		t.Fatal("shot 10 not restored")
	}
	if ann, _ := s10["annotation"].(map[string]any); ann["coffee"] != "Bean X" {
		t.Errorf("annotation not restored: %+v", s10["annotation"])
	}
	tm, _ := repo.TrashMap()
	if len(tm) != 1 || tm["11"] != 555 {
		t.Errorf("trash = %+v; want {11:555} (999 filtered out)", tm)
	}
	bl, _ := repo.GetBlocklist()
	if len(bl) != 2 {
		t.Errorf("blocklist = %v; want 2 entries", bl)
	}
	var libData string
	if err := sqlDB.QueryRow(`SELECT data FROM library WHERE key = 'main'`).Scan(&libData); err != nil {
		t.Fatalf("library row: %v", err)
	}
}
