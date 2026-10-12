package shots

import "testing"

// TestFindPreviousByProfile_SameTimestampUsesLowerID is the #1625 regression:
// for two shots of the same profile and machine taken in the same second, the
// previous shot for the higher id is the lower id rather than nothing (the old
// timestamp-only query skipped the tie entirely).
func TestFindPreviousByProfile_SameTimestampUsesLowerID(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 1000, nil, "V60", nil, nil)

	prev, err := repo.FindPreviousByProfile(2, "V60", 1)
	if err != nil {
		t.Fatalf("FindPreviousByProfile: %v", err)
	}
	if prev == nil {
		t.Fatal("expected shot 1 as the previous shot, got nil")
	}
	if prev.id() != 1 {
		t.Fatalf("previous shot id = %d, want 1", prev.id())
	}
}

// TestFindPreviousByProfile_NoLowerIDTieYieldsNil: a shot never treats an
// equal-timestamp shot with a higher id as its previous one, so the lowest id
// of a tie has no previous shot at all.
func TestFindPreviousByProfile_NoLowerIDTieYieldsNil(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 1000, nil, "V60", nil, nil)

	prev, err := repo.FindPreviousByProfile(1, "V60", 1)
	if err != nil {
		t.Fatalf("FindPreviousByProfile: %v", err)
	}
	if prev != nil {
		t.Fatalf("shot 1 has no earlier shot, got id %d", prev.id())
	}
}

// TestFindPreviousByProfile_StrictlyEarlierStillWins: a strictly older shot
// still outranks any equal-timestamp candidate.
func TestFindPreviousByProfile_StrictlyEarlierStillWins(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, nil, "V60", nil, nil)
	insertShot(t, sqlDB, 3, 3000, nil, "V60", nil, nil)

	prev, err := repo.FindPreviousByProfile(3, "V60", 1)
	if err != nil {
		t.Fatalf("FindPreviousByProfile: %v", err)
	}
	if prev == nil || prev.id() != 2 {
		t.Fatalf("previous = %#v, want shot 2", prev)
	}
}
