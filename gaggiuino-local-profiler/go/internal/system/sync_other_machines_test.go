package system

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newOtherMachinesPoller builds a poller around a fresh registry holding only
// the seeded default machine (host "", so syncOtherMachines skips it) plus a
// wired shots repo.
func newOtherMachinesPoller(t *testing.T) (*Poller, *machines.Registry, *shots.Repository) {
	t.Helper()
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	p := NewPoller(registry, fakeAdapterProvider{adapter: &fakeAdapter{}}, newHubForTest(), newDisabledHAClient())
	repo := shots.NewRepository(sqlDB)
	p.SetShotsRepo(repo)
	return p, registry, repo
}

// addOtherMachine registers one non-default machine. enabled=false flips the
// registry's default-on flag.
func addOtherMachine(t *testing.T, registry *machines.Registry, name, typ, host string, enabled bool) *machines.Machine {
	t.Helper()
	in := machines.MachineInput{Name: &name, Type: &typ, Host: &host}
	if !enabled {
		dis := false
		in.Enabled = &dis
	}
	m, err := registry.CreateMachine(in)
	if err != nil {
		t.Fatalf("CreateMachine(%s): %v", name, err)
	}
	return m
}

// withOtherMachineSyncServer points the non-default-machine pull loop at
// per-machine fake hosts for one test: syncBaseURLFor resolves by machine id
// (so two fake machines never share a URL) and syncClient becomes the plain
// client sync_string_id_test.go's withSyncTestServer also uses, because
// machines.NewGuardedHTTPClient's dialer rejects loopback addresses.
func withOtherMachineSyncServer(t *testing.T, urls map[int64]string) {
	t.Helper()
	origClient, origBase := syncClient, syncBaseURLFor
	syncClient = &http.Client{Timeout: 5 * time.Second}
	syncBaseURLFor = func(_ context.Context, m *machines.Machine) (string, error) {
		u, ok := urls[m.ID]
		if !ok {
			return "", fmt.Errorf("no fake machine server for machine %d", m.ID)
		}
		return u, nil
	}
	t.Cleanup(func() { syncClient, syncBaseURLFor = origClient, origBase })
}

// TestSyncOtherMachines_GaggiuinoMachine2ImportedUnderOwnMachine is the #1146
// end-to-end proof for a Gaggiuino non-default machine: machine 2's shots
// import as 20_000_001..3 with machineId 2, while a pre-existing machine-1
// shot is left untouched.
func TestSyncOtherMachines_GaggiuinoMachine2ImportedUnderOwnMachine(t *testing.T) {
	p, registry, repo := newOtherMachinesPoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)

	if err := repo.Upsert(shots.Shot{"id": int64(300), "timestamp": int64(3000), "datapoints": []any{}, "machineId": int64(1)}); err != nil {
		t.Fatalf("seeding machine-1 shot 300: %v", err)
	}

	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
		"2": shotJSON(`2`, "2000"),
		"3": shotJSON(`3`, "3000"),
	})
	withOtherMachineSyncServer(t, map[int64]string{m2.ID: srv.URL})

	p.syncOtherMachines(context.Background())

	for _, native := range []int64{1, 2, 3} {
		globalID := shots.ToGlobalShotID(m2.ID, native)
		s, err := repo.FindByID(globalID)
		if err != nil {
			t.Fatalf("FindByID(%d): %v", globalID, err)
		}
		if s == nil {
			t.Fatalf("shot %d missing after sync", globalID)
		}
		if mid, _ := s["machineId"].(int64); mid != m2.ID {
			t.Fatalf("shot %d machineId = %#v, want %d", globalID, s["machineId"], m2.ID)
		}
	}

	s300, err := repo.FindByID(300)
	if err != nil {
		t.Fatalf("FindByID(300): %v", err)
	}
	if s300 == nil {
		t.Fatalf("machine-1 shot 300 disappeared during the other-machine sync")
	}
	if mid, _ := s300["machineId"].(int64); mid != 1 {
		t.Fatalf("shot 300 machineId = %#v, want 1", s300["machineId"])
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 4 {
		t.Fatalf("shot count = %d, want 4 (one machine-1 shot + three machine-2 shots)", n)
	}
}

// TestSyncOtherMachines_Blocklists404AndSkipsMalformedShot proves the shared
// backfill helper's per-shot handling reaches the other-machine path too: a
// 404 on native id 2 blocklists its global id, and a torn body on native id 3
// is skipped without stopping the machine's sync.
func TestSyncOtherMachines_Blocklists404AndSkipsMalformedShot(t *testing.T) {
	p, registry, repo := newOtherMachinesPoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)

	srv := newSyncFakeMachine(t, `[{"lastShotId":3}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
		// native id 2 is absent -> 404, permanently missing.
		"3": `{"id":3,"timestamp":3000,"datapoints":`, // torn JSON body -> malformed
	})
	withOtherMachineSyncServer(t, map[int64]string{m2.ID: srv.URL})

	p.syncOtherMachines(context.Background())

	block, err := repo.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if !blocklistHas(block, "20000002") {
		t.Fatalf("blocklist = %v, want it to contain 20000002 (shot 2's global id)", block)
	}

	if s1, err := repo.FindByID(shots.ToGlobalShotID(m2.ID, 1)); err != nil {
		t.Fatalf("FindByID(shot 1): %v", err)
	} else if s1 == nil {
		t.Fatalf("valid shot 1 was not imported")
	}
	if s3, err := repo.FindByID(shots.ToGlobalShotID(m2.ID, 3)); err != nil {
		t.Fatalf("FindByID(shot 3): %v", err)
	} else if s3 != nil {
		t.Fatalf("malformed shot 3 was imported")
	}
}

// TestSyncOtherMachines_TransportErrorIsolatedPerMachine proves one machine's
// transport error aborts only that machine: a later machine still syncs, and
// the default-only state (lastSyncError/lastSyncTime) is never written.
func TestSyncOtherMachines_TransportErrorIsolatedPerMachine(t *testing.T) {
	p, registry, repo := newOtherMachinesPoller(t)
	m2 := addOtherMachine(t, registry, "Broken", "gaggiuino", "machine2.test", true)
	m3 := addOtherMachine(t, registry, "Working", "gaggiuino", "machine3.test", true)

	srv := newSyncFakeMachine(t, `[{"lastShotId":1}]`, map[string]string{
		"1": shotJSON(`1`, "1000"),
	})
	// Machine 2 dials a closed port, so every request is a transport error.
	withOtherMachineSyncServer(t, map[int64]string{
		m2.ID: "http://127.0.0.1:1",
		m3.ID: srv.URL,
	})

	p.syncOtherMachines(context.Background())

	if s, err := repo.FindByID(shots.ToGlobalShotID(m3.ID, 1)); err != nil {
		t.Fatalf("FindByID: %v", err)
	} else if s == nil {
		t.Fatalf("machine 2's transport error stopped machine 3 from syncing")
	}

	st := p.SyncState()
	if st.LastSyncError != nil {
		t.Fatalf("lastSyncError = %q, want nil (the default machine never ran)", *st.LastSyncError)
	}
	if st.LastSync != nil {
		t.Fatalf("lastSyncTime = %q, want nil (the default machine never ran)", *st.LastSync)
	}
}

// TestSyncOtherMachines_DisabledMachineSkipped proves the enabled filter: a
// disabled machine is never dialed and imports nothing.
func TestSyncOtherMachines_DisabledMachineSkipped(t *testing.T) {
	p, registry, repo := newOtherMachinesPoller(t)
	addOtherMachine(t, registry, "Off", "gaggiuino", "machine2.test", false)

	origBase := syncBaseURLFor
	calls := 0
	syncBaseURLFor = func(context.Context, *machines.Machine) (string, error) {
		calls++
		return "", errors.New("syncBaseURLFor must not be called for a disabled machine")
	}
	t.Cleanup(func() { syncBaseURLFor = origBase })

	p.syncOtherMachines(context.Background())

	if calls != 0 {
		t.Fatalf("syncBaseURLFor called %d time(s), want 0 (disabled machine never dialed)", calls)
	}
	if n, err := repo.Count(); err != nil {
		t.Fatalf("Count: %v", err)
	} else if n != 0 {
		t.Fatalf("shot count = %d, want 0", n)
	}
}
