package system

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// withGaggiMateSyncSeams stubs the three pull-loop seams a GaggiMate sync
// uses — the base URL plus the two history fetchers — for one test, restoring
// them on cleanup. index is what syncFetchGaggiMateIndex reports; shot is
// invoked once per native id the loop fetches. The returned counter tracks
// those shot-fetch invocations.
func withGaggiMateSyncSeams(t *testing.T, index int64, shot func(ctx context.Context, base string, nativeID int64) (map[string]any, int, error)) *int {
	t.Helper()
	origBase, origIndex, origShot := syncBaseURLFor, syncFetchGaggiMateIndex, syncFetchGaggiMateShot
	calls := 0
	syncBaseURLFor = func(context.Context, *machines.Machine) (string, error) {
		return "http://gaggimate.test", nil
	}
	syncFetchGaggiMateIndex = func(context.Context, string) (int64, error) { return index, nil }
	syncFetchGaggiMateShot = func(ctx context.Context, base string, nativeID int64) (map[string]any, int, error) {
		calls++
		return shot(ctx, base, nativeID)
	}
	t.Cleanup(func() {
		syncBaseURLFor, syncFetchGaggiMateIndex, syncFetchGaggiMateShot = origBase, origIndex, origShot
	})
	return &calls
}

// TestSyncDefaultMachineShots_GaggiMateDefaultMachineScoped is the #1147
// end-to-end proof: with a GaggiMate registered as the default machine (id 2),
// its shots import under ids 20_000_001/20_000_003 with machineId 2, the 404'd
// shot is blocklisted by its global id, an existing machine-1 shot is left
// alone, and a second sync refetches nothing.
func TestSyncDefaultMachineShots_GaggiMateDefaultMachineScoped(t *testing.T) {
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	name, typ, host := "GaggiMate", "gaggimate", "gaggimate.test"
	gm, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if _, err := registry.SetDefaultMachine(gm.ID); err != nil {
		t.Fatalf("SetDefaultMachine(%d): %v", gm.ID, err)
	}

	p := NewPoller(registry, fakeAdapterProvider{adapter: &fakeAdapter{}}, newHubForTest(), newDisabledHAClient())
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)

	// A pre-existing machine-1 shot must survive the GaggiMate sync untouched.
	if err := repo.Upsert(shots.Shot{"id": int64(300), "timestamp": int64(3000), "datapoints": []any{}, "machineId": int64(1)}); err != nil {
		t.Fatalf("seeding machine-1 shot 300: %v", err)
	}

	calls := withGaggiMateSyncSeams(t, 3, func(_ context.Context, _ string, nativeID int64) (map[string]any, int, error) {
		switch nativeID {
		case 1, 3:
			return map[string]any{"id": nativeID, "timestamp": nativeID * 1000, "datapoints": []any{}}, http.StatusOK, nil
		case 2:
			return nil, http.StatusNotFound, errors.New("gaggimate: 404")
		default:
			t.Fatalf("unexpected native id %d", nativeID)
			return nil, 0, nil
		}
	})

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	for _, globalID := range []int64{20_000_001, 20_000_003} {
		s, err := repo.FindByID(globalID)
		if err != nil {
			t.Fatalf("FindByID(%d): %v", globalID, err)
		}
		if s == nil {
			t.Fatalf("shot %d missing after sync", globalID)
		}
		if mid, _ := s["machineId"].(int64); mid != gm.ID {
			t.Fatalf("shot %d machineId = %#v, want %d", globalID, s["machineId"], gm.ID)
		}
	}

	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if !blocklistHas(block, "20000002") {
		t.Fatalf("blocklist = %v, want it to contain 20000002 (shot 2's global id)", block)
	}
	if blocklistHas(block, "2") {
		t.Fatalf("blocklist = %v, must not contain the bare native id 2", block)
	}

	s300, err := repo.FindByID(300)
	if err != nil {
		t.Fatalf("FindByID(300): %v", err)
	}
	if s300 == nil {
		t.Fatalf("machine-1 shot 300 disappeared during the GaggiMate sync")
	}
	if mid, _ := s300["machineId"].(int64); mid != 1 {
		t.Fatalf("shot 300 machineId = %#v, want 1", s300["machineId"])
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 3 {
		t.Fatalf("shot count = %d, want 3 (one machine-1 shot + two GaggiMate shots)", n)
	}

	before := *calls
	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("second syncDefaultMachineShots: %v", err)
	}
	if *calls != before {
		t.Fatalf("second sync made %d shot fetch(es), want 0 (already up to date)", *calls-before)
	}
}

// blocklistHas reports whether want is present in the blocklist.
func blocklistHas(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
