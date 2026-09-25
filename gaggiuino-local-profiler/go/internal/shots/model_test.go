package shots

import "testing"

// TestToGlobalShotID pins the Node toGlobalShotId(machineId, nativeId)
// arithmetic: machine 1 keeps its native ids, every other machine's shots get a
// machineID*MachineIDOffset-prefixed synthetic id so two machines can never
// collide (#1147).
func TestToGlobalShotID(t *testing.T) {
	cases := []struct {
		machineID int64
		nativeID  int64
		want      int64
	}{
		{1, 5, 5},
		{1, 400, 400},
		{2, 5, 20_000_005},
		{2, 1, 20_000_001},
		{3, 7, 30_000_007},
	}
	for _, tc := range cases {
		if got := ToGlobalShotID(tc.machineID, tc.nativeID); got != tc.want {
			t.Fatalf("ToGlobalShotID(%d, %d) = %d, want %d", tc.machineID, tc.nativeID, got, tc.want)
		}
	}
}

// TestNativeShotIDIfOwned covers the range check the sync cursor relies on
// (#1147, #1148): a blocklist entry (a *global* id) may advance a machine's
// sync only when it really is in that machine's own native window.
func TestNativeShotIDIfOwned(t *testing.T) {
	cases := []struct {
		name      string
		machineID int64
		globalID  int64
		wantID    int64
		wantOk    bool
	}{
		{"machine 1 native", 1, 5, 5, true},
		{"machine 1 zero", 1, 0, 0, false},
		{"machine 1 at offset", 1, 10_000_000, 0, false},
		{"machine 1 second machine id", 1, 20_000_005, 0, false},
		{"machine 2 own id", 2, 20_000_005, 5, true},
		{"machine 2 machine 1 id", 2, 5, 0, false},
		{"machine 2 machine 3 id", 2, 30_000_001, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := NativeShotIDIfOwned(tc.machineID, tc.globalID)
			if got != tc.wantID || ok != tc.wantOk {
				t.Fatalf("NativeShotIDIfOwned(%d, %d) = (%d, %v), want (%d, %v)",
					tc.machineID, tc.globalID, got, ok, tc.wantID, tc.wantOk)
			}
		})
	}
}

// TestMaxNativeShotID_PerMachine is the #1147 repository half: each machine's
// max is read from its own id window, so a second machine's shots (stored at
// machineID*MachineIDOffset+nativeID) report their native id and don't inflate
// machine 1's max, and a machine with no shots reports 0.
func TestMaxNativeShotID_PerMachine(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	seed := []struct {
		id        int64
		machineID int64
	}{
		{400, 1},
		{20_000_003, 2},
		{20_000_007, 2},
	}
	for _, s := range seed {
		if err := repo.Upsert(Shot{
			"id":         s.id,
			"timestamp":  s.id,
			"machineId":  s.machineID,
			"datapoints": []any{},
		}); err != nil {
			t.Fatalf("Upsert(%d, machine %d): %v", s.id, s.machineID, err)
		}
	}

	for _, tc := range []struct {
		machineID int64
		want      int64
	}{
		{1, 400},
		{2, 7},
		{3, 0},
	} {
		got, err := repo.MaxNativeShotID(tc.machineID)
		if err != nil {
			t.Fatalf("MaxNativeShotID(%d): %v", tc.machineID, err)
		}
		if got != tc.want {
			t.Fatalf("MaxNativeShotID(%d) = %d, want %d", tc.machineID, got, tc.want)
		}
	}
}
