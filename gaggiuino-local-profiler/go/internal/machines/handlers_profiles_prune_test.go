package machines

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// listProfilesAdapter is a machines.Adapter whose ListProfiles result is
// scripted per test; GetStatus reports a reachable machine with no current
// profile. The remaining methods fall through to the embedded
// fakeBlockingAdapter (declared in handlers_profiles_timeout_test.go). It
// drives listMachineProfiles' reconciliation with a chosen machine answer for
// the #1610 prune tests.
type listProfilesAdapter struct {
	fakeBlockingAdapter
	profiles []ProfileSummary
	err      error
	bodies   map[string]json.RawMessage // full bodies GetProfile serves (#2162 prefetch)
	gets     *[]string                  // when set, records every GetProfile id in call order
}

var _ Adapter = listProfilesAdapter{}

func (listProfilesAdapter) GetStatus(context.Context, *Machine) (Status, error) {
	return Status{}, nil
}

func (a listProfilesAdapter) ListProfiles(context.Context, *Machine) ([]ProfileSummary, error) {
	return a.profiles, a.err
}

// GetProfile serves the scripted full bodies for the #2162 prefetch; an id
// without a body fails like an unreachable machine, which ends the run.
func (a listProfilesAdapter) GetProfile(_ context.Context, _ *Machine, id string) (json.RawMessage, error) {
	if a.gets != nil {
		*a.gets = append(*a.gets, id)
	}
	if body, ok := a.bodies[id]; ok {
		return body, nil
	}
	return nil, errors.New("listProfilesAdapter: no body for " + id)
}

// TestListMachineProfiles_UnreadableListDoesNotPruneLocalProfiles pins #1610:
// the GET handler must not delete locally synced profiles when the machine's
// answer is unreadable. A ListProfiles error already fell back to the cache,
// but an adapter that returned an empty list (the old shape of both adapters'
// decode-failure path) reached PruneStaleSynced with no remote ids and wiped
// every synced row. Only a genuine, non-empty list is allowed to prune.
func TestListMachineProfiles_UnreadableListDoesNotPruneLocalProfiles(t *testing.T) {
	cases := []struct {
		name    string
		adapter listProfilesAdapter
		want    int
	}{
		{"ListProfiles errors", listProfilesAdapter{err: errors.New("gaggiuino: decoding profile list")}, 2},
		{"ListProfiles returns an empty list", listProfilesAdapter{profiles: nil}, 2},
		{"ListProfiles returns one of the two ids", listProfilesAdapter{profiles: []ProfileSummary{{ID: "remote-2", Name: "Second"}}}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, sqlDB := newTestRegistry(t)
			profilesRepo := NewProfilesRepository(sqlDB)
			h := &Handlers{registry: registry, gaggimate: tc.adapter, profilesRepo: profilesRepo}
			mux := newMux(h)

			machine, err := registry.CreateMachine(MachineInput{
				Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
			})
			if err != nil {
				t.Fatalf("CreateMachine: %v", err)
			}
			for _, p := range []struct{ id, name string }{{"remote-1", "First"}, {"remote-2", "Second"}} {
				if err := profilesRepo.UpsertSynced(machine.ID, p.id, p.name, json.RawMessage(`{"label":"`+p.name+`"}`), false); err != nil {
					t.Fatalf("seeding synced profile %s: %v", p.id, err)
				}
			}

			rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
			}
			rows, err := profilesRepo.ListByMachine(machine.ID)
			if err != nil {
				t.Fatalf("ListByMachine: %v", err)
			}
			if len(rows) != tc.want {
				t.Fatalf("kept %d local rows, want %d: %+v", len(rows), tc.want, rows)
			}
		})
	}
}

// TestListMachineProfiles_PrefetchStoresFullBodiesForOfflineEditing pins #2162:
// a live list reconcile fills every summary-only row with its full body in the
// background, so the editor can open the profile later with the machine off.
func TestListMachineProfiles_PrefetchStoresFullBodiesForOfflineEditing(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	adapter := listProfilesAdapter{
		profiles: []ProfileSummary{{ID: "remote-1", Name: "A"}, {ID: "remote-2", Name: "B"}},
		bodies: map[string]json.RawMessage{
			"remote-1": json.RawMessage(`{"label":"A","phases":[{"type":"PRESSURE"}]}`),
			"remote-2": json.RawMessage(`{"label":"B","phases":[{"type":"FLOW"}]}`),
		},
	}
	h := &Handlers{registry: registry, gaggimate: adapter, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	h.profilePrefetchWG.Wait()

	for _, id := range []string{"remote-1", "remote-2"} {
		row, err := profilesRepo.Get(machine.ID, id)
		if err != nil || row == nil {
			t.Fatalf("Get(%q): %v", id, err)
		}
		if !hasFullProfileBody(row.Data) {
			t.Errorf("row %q still holds only the summary: %s", id, row.Data)
		}
	}

	h.SetKnownUnreachable(func(id int64) bool { return id == machine.ID })
	rec = doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profile/remote-1?machineId="+strconv.FormatInt(machine.ID, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("offline GET status = %d, body = %s", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec.Body.Bytes())
	phases, _ := body["phases"].([]any)
	if len(phases) != 1 {
		t.Fatalf("phases = %v, want one phase from the prefetched body", body["phases"])
	}
}

// TestListMachineProfiles_PrefetchSkipsLocalEditsAndFullRows pins the sync
// semantics of the prefetch: only synced, remote-id, summary-only rows are
// fetched; a full body, a dirty edit and a different remote id are left alone.
func TestListMachineProfiles_PrefetchSkipsLocalEditsAndFullRows(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	var gets []string
	adapter := listProfilesAdapter{
		profiles: []ProfileSummary{
			{ID: "remote-1", Name: "A"}, {ID: "remote-2", Name: "B"}, {ID: "remote-3", Name: "C"},
		},
		bodies: map[string]json.RawMessage{
			"remote-1": json.RawMessage(`{"label":"A","phases":[{"type":"PRESSURE"}]}`),
			"remote-2": json.RawMessage(`{"label":"B","phases":[{"type":"FLOW"}]}`),
			"remote-3": json.RawMessage(`{"label":"C","phases":[{"type":"FLOW"}]}`),
		},
		gets: &gets,
	}
	h := &Handlers{registry: registry, gaggimate: adapter, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	seededBody := json.RawMessage(`{"label":"A","phases":[{"type":"FLOW"},{"type":"PRESSURE"}]}`)
	if err := profilesRepo.UpsertSynced(machine.ID, "remote-1", "A", seededBody, false); err != nil {
		t.Fatalf("UpsertSynced(remote-1): %v", err)
	}
	if err := profilesRepo.UpsertListSummary(machine.ID, "remote-2", "B", false); err != nil {
		t.Fatalf("UpsertListSummary(remote-2): %v", err)
	}
	dirtyRow, err := profilesRepo.Get(machine.ID, "remote-2")
	if err != nil || dirtyRow == nil {
		t.Fatalf("Get(remote-2): %v", err)
	}
	remoteID := "remote-2"
	if _, err := profilesRepo.UpsertDirty(machine.ID, &dirtyRow.LocalID, &remoteID, "B", json.RawMessage(`{"v":2}`)); err != nil {
		t.Fatalf("UpsertDirty(remote-2): %v", err)
	}

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	h.profilePrefetchWG.Wait()

	if len(gets) != 1 || gets[0] != "remote-3" {
		t.Fatalf("GetProfile calls = %v, want [remote-3]", gets)
	}
	full, err := profilesRepo.Get(machine.ID, "remote-1")
	if err != nil || full == nil {
		t.Fatalf("Get(remote-1): %v", err)
	}
	if string(full.Data) != string(seededBody) {
		t.Errorf("remote-1 data = %s, want its own seeded body untouched", full.Data)
	}
	dirty, err := profilesRepo.Get(machine.ID, "remote-2")
	if err != nil || dirty == nil {
		t.Fatalf("Get(remote-2): %v", err)
	}
	if dirty.SyncStatus != ProfileSyncDirty || string(dirty.Data) != `{"v":2}` {
		t.Errorf("remote-2 = %+v, want the dirty edit preserved", dirty)
	}
	filled, err := profilesRepo.Get(machine.ID, "remote-3")
	if err != nil || filled == nil {
		t.Fatalf("Get(remote-3): %v", err)
	}
	if string(filled.Data) != string(adapter.bodies["remote-3"]) {
		t.Errorf("remote-3 data = %s, want the adapter body", filled.Data)
	}
}

// TestListMachineProfiles_PrefetchStopsAtFirstFailure pins the run's stop
// condition: one failed fetch ends the run instead of retrying every row.
func TestListMachineProfiles_PrefetchStopsAtFirstFailure(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	var gets []string
	adapter := listProfilesAdapter{
		profiles: []ProfileSummary{{ID: "remote-1", Name: "A"}, {ID: "remote-2", Name: "B"}},
		bodies: map[string]json.RawMessage{
			"remote-2": json.RawMessage(`{"label":"B","phases":[{"type":"FLOW"}]}`),
		},
		gets: &gets,
	}
	h := &Handlers{registry: registry, gaggimate: adapter, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	h.profilePrefetchWG.Wait()

	if len(gets) != 1 || gets[0] != "remote-1" {
		t.Fatalf("GetProfile calls = %v, want [remote-1] (the run stops at the first failure)", gets)
	}
	second, err := profilesRepo.Get(machine.ID, "remote-2")
	if err != nil || second == nil {
		t.Fatalf("Get(remote-2): %v", err)
	}
	if string(second.Data) != `{}` {
		t.Errorf("remote-2 data = %s, want the untouched summary placeholder", second.Data)
	}
}
