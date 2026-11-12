package achievements

import "testing"

// TestReplaceAll_RoundTripsRows (#1197 part B): the restore write replaces the
// whole table in one transaction, and keeps a NULL unlockedAt/progress
// distinct from 0.
func TestReplaceAll_RoundTripsRows(t *testing.T) {
	env := newTestEnv(t)
	repo := NewRepository(env.db)

	// A pre-existing row that ReplaceAll must remove.
	if err := repo.Unlock("stale", 1, nil); err != nil {
		t.Fatalf("seeding stale row: %v", err)
	}

	unlockedAt := int64(1_700_000_000)
	progress := int64(7)
	rows := []Row{
		{ID: "first_shot", UnlockedAt: &unlockedAt, Progress: nil},
		{ID: "progress_only", UnlockedAt: nil, Progress: &progress},
	}
	if err := repo.ReplaceAll(rows); err != nil {
		t.Fatalf("ReplaceAll: %v", err)
	}

	got, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	if _, ok := got["stale"]; ok {
		t.Errorf("ReplaceAll left the stale row: %+v", got)
	}
	first, ok := got["first_shot"]
	if !ok || first.UnlockedAt == nil || *first.UnlockedAt != unlockedAt || first.Progress != nil {
		t.Errorf("first_shot row = %+v", first)
	}
	p, ok := got["progress_only"]
	if !ok || p.UnlockedAt != nil || p.Progress == nil || *p.Progress != progress {
		t.Errorf("progress_only row = %+v", p)
	}
}

// TestReplaceAll_EmptyClearsTable pins that a backup with no badges clears the
// target's table rather than leaving the old rows behind.
func TestReplaceAll_EmptyClearsTable(t *testing.T) {
	env := newTestEnv(t)
	repo := NewRepository(env.db)

	if err := repo.Unlock("first_shot", 1, nil); err != nil {
		t.Fatalf("seeding row: %v", err)
	}
	if err := repo.ReplaceAll(nil); err != nil {
		t.Fatalf("ReplaceAll(nil): %v", err)
	}

	got, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("achievements not cleared: %+v", got)
	}
}

// TestUnlock_UpgradesALockedProgressRow (#2021): a badge whose progress row was
// written by SetProgress must still unlock — the upsert sees unlocked_at NULL
// and fills it in instead of ignoring the existing row.
func TestUnlock_UpgradesALockedProgressRow(t *testing.T) {
	env := newTestEnv(t)
	repo := NewRepository(env.db)

	if err := repo.SetProgress("x", 3); err != nil {
		t.Fatalf("SetProgress: %v", err)
	}

	progress := int64(10)
	if err := repo.Unlock("x", 100, &progress); err != nil {
		t.Fatalf("Unlock: %v", err)
	}

	got, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	row, ok := got["x"]
	if !ok || row.UnlockedAt == nil || *row.UnlockedAt != 100 {
		t.Fatalf("x row = %+v, want unlockedAt 100", row)
	}
	if row.Progress == nil || *row.Progress != 10 {
		t.Errorf("x progress = %v, want 10", row.Progress)
	}
}

// TestUnlock_KeepsTheOriginalUnlock pins idempotency: a second Unlock must not
// move unlocked_at or overwrite the stored progress.
func TestUnlock_KeepsTheOriginalUnlock(t *testing.T) {
	env := newTestEnv(t)
	repo := NewRepository(env.db)

	progress := int64(10)
	if err := repo.Unlock("x", 100, &progress); err != nil {
		t.Fatalf("first Unlock: %v", err)
	}
	if err := repo.Unlock("x", 200, &progress); err != nil {
		t.Fatalf("second Unlock: %v", err)
	}

	got, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	row := got["x"]
	if row.UnlockedAt == nil || *row.UnlockedAt != 100 {
		t.Fatalf("x unlockedAt = %v, want the original 100", row.UnlockedAt)
	}
}

// TestSetProgress_LeavesAnUnlockedRowAlone guards the other direction: a
// progress write never disturbs a row Unlock already stamped.
func TestSetProgress_LeavesAnUnlockedRowAlone(t *testing.T) {
	env := newTestEnv(t)
	repo := NewRepository(env.db)

	progress := int64(10)
	if err := repo.Unlock("x", 100, &progress); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if err := repo.SetProgress("x", 3); err != nil {
		t.Fatalf("SetProgress: %v", err)
	}

	got, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	row := got["x"]
	if row.UnlockedAt == nil || *row.UnlockedAt != 100 {
		t.Fatalf("x unlockedAt = %v, want 100", row.UnlockedAt)
	}
	if row.Progress == nil || *row.Progress != 10 {
		t.Errorf("x progress = %v, want the unlocked 10", row.Progress)
	}
}
