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
}

var _ Adapter = listProfilesAdapter{}

func (listProfilesAdapter) GetStatus(context.Context, *Machine) (Status, error) {
	return Status{}, nil
}

func (a listProfilesAdapter) ListProfiles(context.Context, *Machine) ([]ProfileSummary, error) {
	return a.profiles, a.err
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
