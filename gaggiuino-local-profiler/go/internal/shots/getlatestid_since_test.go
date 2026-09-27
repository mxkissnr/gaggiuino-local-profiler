package shots

import "testing"

// TestGetLatestID_SinceSec covers the #1197 extension: a sinceSec lower bound
// filters out older shots for order matching, while sinceSec == 0 keeps the
// original "globally latest" behaviour.
func TestGetLatestID_SinceSec(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	insertShot(t, sqlDB, 1, 1000, nil, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, nil, "V60", nil, nil)
	insertShot(t, sqlDB, 3, 3000, nil, "V60", nil, nil)

	cases := []struct {
		name      string
		machineID int64
		sinceSec  int64
		wantID    int64
		wantOK    bool
	}{
		{"zero keeps latest", 1, 0, 3, true},
		{"since before all keeps latest", 1, 500, 3, true},
		{"boundary is inclusive", 1, 3000, 3, true},
		{"since above every shot matches none", 1, 3001, 0, false},
		{"global machine 0 honours since", 0, 2500, 3, true},
		{"global machine 0 since above none", 0, 3001, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, ok, err := repo.GetLatestID(tc.machineID, tc.sinceSec)
			if err != nil {
				t.Fatalf("GetLatestID(%d, %d): %v", tc.machineID, tc.sinceSec, err)
			}
			if ok != tc.wantOK || id != tc.wantID {
				t.Fatalf("GetLatestID(%d, %d) = (%d, %v), want (%d, %v)",
					tc.machineID, tc.sinceSec, id, ok, tc.wantID, tc.wantOK)
			}
		})
	}
}
