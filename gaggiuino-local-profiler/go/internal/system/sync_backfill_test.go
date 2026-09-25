package system

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestBackfillShots_Direct exercises the shared helper on its own (the #1146
// slice 2a groundwork): it resumes from machineID's own max native id, skips an
// id-less shot, stores the rest under the global ids prepare assigns, and
// blocklists a 404 by that machine's global id rather than its bare native id.
func TestBackfillShots_Direct(t *testing.T) {
	p, sqlDB := newTestPoller(t, &fakeAdapter{})
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	// Machine 2's shot 2 is already stored: the helper must resume at 3.
	if err := repo.Upsert(shots.Shot{"id": int64(20_000_002), "timestamp": int64(2000), "datapoints": []any{}, "machineId": int64(2)}); err != nil {
		t.Fatalf("seeding machine-2 shot 2: %v", err)
	}

	err := p.backfillShots(context.Background(), 2, 5,
		func(_ context.Context, native int64) (map[string]any, int, error) {
			switch native {
			case 3:
				return map[string]any{"id": native, "datapoints": []any{}}, http.StatusOK, nil
			case 4:
				return nil, http.StatusNotFound, errors.New("machine returned HTTP 404 for shot 4")
			case 5:
				return map[string]any{"datapoints": []any{}}, http.StatusOK, nil
			}
			t.Fatalf("unexpected native id %d", native)
			return nil, 0, nil
		},
		func(shot map[string]any, native int64) bool {
			shot["id"] = shots.ToGlobalShotID(2, native)
			shot["machineId"] = int64(2)
			return true
		},
		backfillLogs{prefix: "system: sync", notFoundSuffix: " on machine", invalidReason: "has invalid data"})
	if err != nil {
		t.Fatalf("backfillShots: %v", err)
	}

	if s, err := repo.FindByID(20_000_003); err != nil {
		t.Fatalf("FindByID(20000003): %v", err)
	} else if s == nil {
		t.Fatalf("shot 20000003 missing after backfill")
	}
	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if !blocklistHas(block, "20000004") {
		t.Fatalf("blocklist = %v, want it to contain 20000004 (shot 4's global id)", block)
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 2 {
		t.Fatalf("shot count = %d, want 2 (seeded shot plus shot 3)", n)
	}
}
