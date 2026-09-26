package system

import (
	"context"
	"os"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newDefaultGaggiuinoSync registers a Gaggiuino whose id is not 1 as the
// default machine (the #1162 setup every test in this file needs) and returns
// the poller, the shots repo and that machine.
func newDefaultGaggiuinoSync(t *testing.T) (*Poller, *shots.Repository, *machines.Machine) {
	t.Helper()
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	name, typ, host := "Gaggiuino 2", "gaggiuino", "gaggiuino2.test"
	m, err := registry.CreateMachine(machines.MachineInput{Name: &name, Type: &typ, Host: &host})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if _, err := registry.SetDefaultMachine(m.ID); err != nil {
		t.Fatalf("SetDefaultMachine(%d): %v", m.ID, err)
	}
	p := NewPoller(registry, fakeAdapterProvider{adapter: &fakeAdapter{}}, newHubForTest(), newDisabledHAClient())
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	return p, repo, m
}

// shots123SyncServer serves a machine reporting shots 1..3 with the given
// timestamps and points the pull loop at it.
func shots123SyncServer(t *testing.T, shotsByID map[string]string) {
	t.Helper()
	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, shotsByID)
	withSyncTestServer(t, srv.URL)
}

// TestSyncDefaultGaggiuino_MachineScoped is the #1162 end-to-end proof: a
// Gaggiuino whose id is not 1 but which is the default machine imports its
// shots under its own global ids (20_000_001..3) stamped machineId 2, stores
// no bare native-id rows, and a second sync refetches nothing.
func TestSyncDefaultGaggiuino_MachineScoped(t *testing.T) {
	p, repo, m := newDefaultGaggiuinoSync(t)
	shots123SyncServer(t, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	for i := int64(1); i <= 3; i++ {
		globalID := shots.ToGlobalShotID(m.ID, i)
		s, err := repo.FindByID(globalID)
		if err != nil {
			t.Fatalf("FindByID(%d): %v", globalID, err)
		}
		if s == nil {
			t.Fatalf("shot %d missing after sync", globalID)
		}
		if mid, _ := s["machineId"].(int64); mid != m.ID {
			t.Fatalf("shot %d machineId = %#v, want %d", globalID, s["machineId"], m.ID)
		}
		if native, err := repo.FindByID(i); err != nil {
			t.Fatalf("FindByID(%d): %v", i, err)
		} else if native != nil {
			t.Fatalf("shot %d stored under its bare native id instead of %d", i, globalID)
		}
	}
	if max, err := repo.MaxNativeShotID(m.ID); err != nil {
		t.Fatalf("MaxNativeShotID: %v", err)
	} else if max != 3 {
		t.Fatalf("MaxNativeShotID(%d) = %d, want 3", m.ID, max)
	}

	before, err := repo.Count()
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("second syncDefaultMachineShots: %v", err)
	}
	if after, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if after != before {
		t.Fatalf("second sync changed the shot count: %d -> %d", before, after)
	}
}

// TestSyncDefaultGaggiuino_MisfiledRowMoved covers the maintainer's "move the
// duplicates" decision: a machine-1 row that is really one of this machine's
// shots (same native id and timestamp) is moved to the global id, annotation
// and all, rather than left behind as a duplicate.
func TestSyncDefaultGaggiuino_MisfiledRowMoved(t *testing.T) {
	p, repo, m := newDefaultGaggiuinoSync(t)

	if err := repo.Upsert(shots.Shot{"id": int64(2), "timestamp": int64(2000), "datapoints": []any{}, "machineId": int64(1)}); err != nil {
		t.Fatalf("seeding misfiled shot 2: %v", err)
	}
	if err := repo.SaveAnnotation(2, map[string]any{"dose": 18}); err != nil {
		t.Fatalf("SaveAnnotation(2): %v", err)
	}

	shots123SyncServer(t, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	if old, err := repo.FindByID(2); err != nil {
		t.Fatalf("FindByID(2): %v", err)
	} else if old != nil {
		t.Fatalf("misfiled shot 2 still present after sync: %+v", old)
	}
	globalID := shots.ToGlobalShotID(m.ID, 2)
	got, err := repo.FindByID(globalID)
	if err != nil {
		t.Fatalf("FindByID(%d): %v", globalID, err)
	}
	if got == nil {
		t.Fatalf("shot %d missing after sync", globalID)
	}
	if mid, _ := got["machineId"].(int64); mid != m.ID {
		t.Fatalf("moved shot machineId = %#v, want %d", got["machineId"], m.ID)
	}
	ann, err := repo.GetAnnotation(globalID)
	if err != nil {
		t.Fatalf("GetAnnotation(%d): %v", globalID, err)
	}
	if ann["dose"] == nil {
		t.Fatalf("annotation lost in move: %+v", ann)
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 3 {
		t.Fatalf("shot count = %d, want 3 (moved duplicate must not be extra)", n)
	}
}

// TestSyncDefaultGaggiuino_MachineOneOwnShotUntouched: a machine-1 row with the
// same native id but a different timestamp is machine 1's own shot — it must
// stay exactly as it was while the default machine's copy lands under its own
// global id.
func TestSyncDefaultGaggiuino_MachineOneOwnShotUntouched(t *testing.T) {
	p, repo, m := newDefaultGaggiuinoSync(t)

	if err := repo.Upsert(shots.Shot{"id": int64(2), "timestamp": int64(9999), "datapoints": []any{}, "machineId": int64(1)}); err != nil {
		t.Fatalf("seeding machine-1 shot 2: %v", err)
	}
	if err := repo.SaveAnnotation(2, map[string]any{"dose": 21}); err != nil {
		t.Fatalf("SaveAnnotation(2): %v", err)
	}

	shots123SyncServer(t, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	s2, err := repo.FindByID(2)
	if err != nil {
		t.Fatalf("FindByID(2): %v", err)
	}
	if s2 == nil {
		t.Fatalf("machine 1's own shot 2 disappeared")
	}
	if ts, _ := s2["timestamp"].(int64); ts != 9999 {
		t.Fatalf("machine-1 shot 2 timestamp = %#v, want 9999 (untouched)", s2["timestamp"])
	}
	if mid, _ := s2["machineId"].(int64); mid != 1 {
		t.Fatalf("machine-1 shot 2 machineId = %#v, want 1", s2["machineId"])
	}
	ann, err := repo.GetAnnotation(2)
	if err != nil {
		t.Fatalf("GetAnnotation(2): %v", err)
	}
	if ann["dose"] == nil {
		t.Fatalf("machine-1 shot 2 annotation changed: %+v", ann)
	}
	if s, err := repo.FindByID(shots.ToGlobalShotID(m.ID, 2)); err != nil {
		t.Fatalf("FindByID(global 2): %v", err)
	} else if s == nil {
		t.Fatalf("default machine's shot 2 missing after sync")
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 4 {
		t.Fatalf("shot count = %d, want 4 (machine-1 shot plus this machine's three)", n)
	}
}

// withSyncImageDir points the #1162 moved-photo helper at a temp dir for one
// test and restores the production image directory afterwards.
func withSyncImageDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	orig := syncImageDir
	syncImageDir = dir
	t.Cleanup(func() { syncImageDir = orig })
	return dir
}

// TestSyncDefaultGaggiuino_MovesPhotoFiles is the #1162 follow-up proof: when
// a misfiled shot carrying a photo is moved to its global id, both its full
// image and its thumbnail are renamed to the new id instead of being left
// behind under the old one.
func TestSyncDefaultGaggiuino_MovesPhotoFiles(t *testing.T) {
	p, repo, m := newDefaultGaggiuinoSync(t)
	dir := withSyncImageDir(t)

	if err := repo.Upsert(shots.Shot{"id": int64(2), "timestamp": int64(2000), "datapoints": []any{}, "machineId": int64(1)}); err != nil {
		t.Fatalf("seeding misfiled shot 2: %v", err)
	}
	if _, err := repo.SetImage(2, "jpg"); err != nil {
		t.Fatalf("SetImage(2): %v", err)
	}
	fullOld := img.Path(dir, 2, "jpg", "shot-")
	thumbOld := img.ThumbPath(dir, 2, "jpg", "shot-")
	for _, f := range []string{fullOld, thumbOld} {
		if err := os.WriteFile(f, []byte("photo"), 0o644); err != nil {
			t.Fatalf("writing %s: %v", f, err)
		}
	}

	shots123SyncServer(t, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	globalID := shots.ToGlobalShotID(m.ID, 2)
	if s, err := repo.FindByID(globalID); err != nil {
		t.Fatalf("FindByID(%d): %v", globalID, err)
	} else if s == nil {
		t.Fatalf("shot %d missing after sync", globalID)
	}
	for _, f := range []string{fullOld, thumbOld} {
		if _, err := os.Stat(f); !os.IsNotExist(err) {
			t.Fatalf("old photo file %s still present after move (err = %v)", f, err)
		}
	}
	for _, f := range []string{img.Path(dir, globalID, "jpg", "shot-"), img.ThumbPath(dir, globalID, "jpg", "shot-")} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("moved photo file %s missing: %v", f, err)
		}
	}
}

// TestSyncDefaultGaggiuino_MoveWithoutPhotoFiles: a misfiled shot with no
// stored image still moves, and the move creates no phantom files under the
// new id.
func TestSyncDefaultGaggiuino_MoveWithoutPhotoFiles(t *testing.T) {
	p, repo, m := newDefaultGaggiuinoSync(t)
	dir := withSyncImageDir(t)

	if err := repo.Upsert(shots.Shot{"id": int64(2), "timestamp": int64(2000), "datapoints": []any{}, "machineId": int64(1)}); err != nil {
		t.Fatalf("seeding misfiled shot 2: %v", err)
	}

	shots123SyncServer(t, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	globalID := shots.ToGlobalShotID(m.ID, 2)
	if s, err := repo.FindByID(globalID); err != nil {
		t.Fatalf("FindByID(%d): %v", globalID, err)
	} else if s == nil {
		t.Fatalf("shot %d missing after sync", globalID)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	if len(entries) != 0 {
		t.Fatalf("image dir has %d entries, want 0: %v", len(entries), entries)
	}
}
