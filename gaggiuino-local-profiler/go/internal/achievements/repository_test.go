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
