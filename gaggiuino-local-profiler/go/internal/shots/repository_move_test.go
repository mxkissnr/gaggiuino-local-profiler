package shots

import "testing"

// ── MoveMisfiledShot (#1162) ────────────────────────────────────────────

// TestMoveMisfiledShot_MovesRowAndChildren is the happy path: a machine-1 row
// whose native id and timestamp match a shot the default machine is
// re-importing is moved to its global id, taking its annotation and trash
// entry with it and dropping its now-stale score-cache row.
func TestMoveMisfiledShot_MovesRowAndChildren(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	insertShot(t, sqlDB, 5, 5000, &dur, "Espresso", nil, map[string]any{"dose": 18})
	if err := repo.MoveToTrash(5); err != nil {
		t.Fatalf("MoveToTrash(5): %v", err)
	}
	if _, err := sqlDB.Exec(
		`INSERT INTO shot_score_cache (shot_id, score, used_bean_target, fingerprint, computed_at) VALUES (5, 80, 0, 'fp', 0)`,
	); err != nil {
		t.Fatalf("seeding score cache: %v", err)
	}

	moved, err := repo.MoveMisfiledShot(5, 5000, 2)
	if err != nil {
		t.Fatalf("MoveMisfiledShot: %v", err)
	}
	if !moved {
		t.Fatalf("MoveMisfiledShot moved = false, want true")
	}

	if old, err := repo.FindByID(5); err != nil {
		t.Fatalf("FindByID(5): %v", err)
	} else if old != nil {
		t.Fatalf("shot 5 still present after move: %+v", old)
	}

	got, err := repo.FindByID(20_000_005)
	if err != nil {
		t.Fatalf("FindByID(20000005): %v", err)
	}
	if got == nil {
		t.Fatalf("shot 20000005 missing after move")
	}
	if mid, _ := got["machineId"].(int64); mid != 2 {
		t.Fatalf("moved shot machineId = %#v, want 2", got["machineId"])
	}
	ann, err := repo.GetAnnotation(20_000_005)
	if err != nil {
		t.Fatalf("GetAnnotation(20000005): %v", err)
	}
	if ann["dose"] == nil {
		t.Fatalf("annotation lost in move: %+v", ann)
	}
	if _, ok, err := repo.GetTrashEntry(20_000_005); err != nil {
		t.Fatalf("GetTrashEntry(20000005): %v", err)
	} else if !ok {
		t.Fatalf("trash entry not re-keyed to 20000005")
	}
	if _, ok, err := repo.GetTrashEntry(5); err != nil {
		t.Fatalf("GetTrashEntry(5): %v", err)
	} else if ok {
		t.Fatalf("old trash entry for 5 still present")
	}

	var n int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM shot_score_cache WHERE shot_id = 5`).Scan(&n); err != nil {
		t.Fatalf("counting score cache: %v", err)
	}
	if n != 0 {
		t.Fatalf("score cache rows for shot 5 = %d, want 0", n)
	}
}

// TestMoveMisfiledShot_TimestampMismatchLeavesRow: a machine-1 row with the
// same id but a different timestamp is machine 1's own shot, so nothing moves.
func TestMoveMisfiledShot_TimestampMismatchLeavesRow(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	insertShot(t, sqlDB, 5, 5000, &dur, "Espresso", nil, map[string]any{"dose": 18})

	moved, err := repo.MoveMisfiledShot(5, 9999, 2)
	if err != nil {
		t.Fatalf("MoveMisfiledShot: %v", err)
	}
	if moved {
		t.Fatalf("MoveMisfiledShot moved = true, want false on a timestamp mismatch")
	}

	if s, err := repo.FindByID(5); err != nil {
		t.Fatalf("FindByID(5): %v", err)
	} else if s == nil {
		t.Fatalf("shot 5 disappeared on a timestamp mismatch")
	}
	if s, err := repo.FindByID(20_000_005); err != nil {
		t.Fatalf("FindByID(20000005): %v", err)
	} else if s != nil {
		t.Fatalf("shot 20000005 created on a timestamp mismatch")
	}
	ann, err := repo.GetAnnotation(5)
	if err != nil {
		t.Fatalf("GetAnnotation(5): %v", err)
	}
	if ann["dose"] == nil {
		t.Fatalf("annotation for shot 5 changed on a timestamp mismatch: %+v", ann)
	}
}

// TestMoveMisfiledShot_MachineOneIsNoop: for machine 1 the global id is the
// native id, so the whole move is a no-op.
func TestMoveMisfiledShot_MachineOneIsNoop(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	insertShot(t, sqlDB, 5, 5000, &dur, "Espresso", nil, nil)

	moved, err := repo.MoveMisfiledShot(5, 5000, 1)
	if err != nil {
		t.Fatalf("MoveMisfiledShot: %v", err)
	}
	if moved {
		t.Fatalf("MoveMisfiledShot moved = true for machine 1, want false")
	}
	if s, err := repo.FindByID(5); err != nil {
		t.Fatalf("FindByID(5): %v", err)
	} else if s == nil {
		t.Fatalf("shot 5 disappeared for a machine-1 move")
	}
}

// TestMoveMisfiledShot_TargetTakenLeavesBoth: when the global id is already
// occupied the move must not clobber it, and must not delete the source either.
func TestMoveMisfiledShot_TargetTakenLeavesBoth(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)

	dur := int64(300)
	insertShot(t, sqlDB, 5, 5000, &dur, "Espresso", nil, map[string]any{"dose": 18})
	if _, err := sqlDB.Exec(
		`INSERT INTO shots (id, timestamp, data, machine_id) VALUES (?,?,?,?)`,
		20_000_005, 7000, "{}", 2,
	); err != nil {
		t.Fatalf("seeding target row: %v", err)
	}

	moved, err := repo.MoveMisfiledShot(5, 5000, 2)
	if err != nil {
		t.Fatalf("MoveMisfiledShot: %v", err)
	}
	if moved {
		t.Fatalf("MoveMisfiledShot moved = true, want false when the target is taken")
	}

	if s, err := repo.FindByID(5); err != nil {
		t.Fatalf("FindByID(5): %v", err)
	} else if s == nil {
		t.Fatalf("source shot 5 deleted while the target was taken")
	}
	tgt, err := repo.FindByID(20_000_005)
	if err != nil {
		t.Fatalf("FindByID(20000005): %v", err)
	}
	if tgt == nil {
		t.Fatalf("target shot 20000005 disappeared")
	}
	if ts, _ := tgt["timestamp"].(int64); ts != 7000 {
		t.Fatalf("target shot 20000005 timestamp = %#v, want 7000 (untouched)", tgt["timestamp"])
	}
}
