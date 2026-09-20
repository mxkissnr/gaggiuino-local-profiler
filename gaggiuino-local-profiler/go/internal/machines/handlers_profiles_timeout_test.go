package machines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// fakeBlockingAdapter simulates an unreachable machine whose live call never
// returns on its own (e.g. gaggimate.local's mDNS name hanging on the OS
// resolver, observed hanging past 60s in the wild) — it blocks until ctx is
// cancelled and then returns ctx.Err(), exactly like the real WS client's
// Request() does (gaggimate_live.go's explicit `case <-ctx.Done()`). Only
// GetStatus/ListProfiles/GetProfile are exercised by the tests below; every
// other method panics if that ever changes.
type fakeBlockingAdapter struct{}

var _ Adapter = fakeBlockingAdapter{}

func (fakeBlockingAdapter) Capabilities() Capabilities { return Capabilities{} }

func (fakeBlockingAdapter) GetStatus(ctx context.Context, m *Machine) (Status, error) {
	<-ctx.Done()
	return Status{}, ctx.Err()
}
func (fakeBlockingAdapter) ListProfiles(ctx context.Context, m *Machine) ([]ProfileSummary, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (fakeBlockingAdapter) GetProfile(ctx context.Context, m *Machine, id string) (json.RawMessage, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (fakeBlockingAdapter) notImplemented(name string) error {
	panic("fakeBlockingAdapter: unexpected call to " + name)
}
func (f fakeBlockingAdapter) CreateProfile(context.Context, *Machine, ProfileInput) (ProfileSummary, error) {
	return ProfileSummary{}, f.notImplemented("CreateProfile")
}
func (f fakeBlockingAdapter) UpdateProfile(context.Context, *Machine, ProfileInput) (ProfileSummary, error) {
	return ProfileSummary{}, f.notImplemented("UpdateProfile")
}
func (f fakeBlockingAdapter) DeleteProfile(context.Context, *Machine, string) ([]ProfileSummary, error) {
	return nil, f.notImplemented("DeleteProfile")
}
func (f fakeBlockingAdapter) SelectProfile(context.Context, *Machine, string) error {
	return f.notImplemented("SelectProfile")
}
func (f fakeBlockingAdapter) GetSettings(context.Context, *Machine, string) (json.RawMessage, error) {
	return nil, f.notImplemented("GetSettings")
}
func (fakeBlockingAdapter) UpdateSettings(context.Context, *Machine, string, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (f fakeBlockingAdapter) SaveSettings(context.Context, *Machine) error {
	return f.notImplemented("SaveSettings")
}
func (f fakeBlockingAdapter) SetOperationMode(context.Context, *Machine, proto.OperationMode) error {
	return f.notImplemented("SetOperationMode")
}
func (f fakeBlockingAdapter) Tare(context.Context, *Machine) error {
	return f.notImplemented("Tare")
}
func (f fakeBlockingAdapter) ServiceTest(context.Context, *Machine, proto.ServiceTestPeripheral) error {
	return f.notImplemented("ServiceTest")
}
func (f fakeBlockingAdapter) SaveActiveProfile(context.Context, *Machine) error {
	return f.notImplemented("SaveActiveProfile")
}
func (f fakeBlockingAdapter) GetFirmwareProgress(context.Context, *Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("GetFirmwareProgress")
}
func (f fakeBlockingAdapter) TriggerFirmwareUpdate(context.Context, *Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("TriggerFirmwareUpdate")
}
func (f fakeBlockingAdapter) GetLiveSensorSnapshot(context.Context, *Machine) (*proto.SensorStateSnapshotDto, error) {
	return nil, f.notImplemented("GetLiveSensorSnapshot")
}
func (f fakeBlockingAdapter) GetLiveSystemState(context.Context, *Machine) (*proto.SystemStateDto, error) {
	return nil, f.notImplemented("GetLiveSystemState")
}

// TestListMachineProfiles_UnreachableMachineFallsBackWithinTimeout is the
// regression test for the "profiles disappear after reload" bug report: an
// unreachable machine's ListProfiles/GetStatus used to be called with the
// bare, unbounded r.Context() — a real gaggimate.local mDNS lookup hanging
// on the OS resolver blocked the request for 60+ seconds before the
// existing local-cache fallback ever got a chance to run. Both calls must
// now be bounded by profileLiveFetchTimeout, so the fallback kicks in
// promptly even against an adapter that never returns on its own.
func TestListMachineProfiles_UnreachableMachineFallsBackWithinTimeout(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	h := &Handlers{registry: registry, gaggimate: fakeBlockingAdapter{}, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if err := profilesRepo.UpsertSynced(machine.ID, "remote-1", "Cached Profile", json.RawMessage(`{"label":"Cached Profile"}`), false); err != nil {
		t.Fatalf("seeding cached profile: %v", err)
	}

	start := time.Now()
	req := httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil)
	rec := doRequest(mux, req)
	elapsed := time.Since(start)

	// Generous slack over profileLiveFetchTimeout (5s) — this must never
	// approach the old 60+s hang; a regression here would fail loudly.
	if elapsed > profileLiveFetchTimeout+3*time.Second {
		t.Fatalf("listMachineProfiles took %v against an unreachable machine; want well under %v (the bounded timeout)", elapsed, profileLiveFetchTimeout)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["stale"] != true {
		t.Errorf("stale = %v, want true (machine unreachable, served from local cache)", body["stale"])
	}
	optionsRaw, _ := body["optionsRaw"].([]any)
	if len(optionsRaw) != 1 {
		t.Fatalf("expected 1 cached profile in the fallback response, got %d: %+v", len(optionsRaw), body)
	}
}

// TestGetMachineProfile_UnreachableMachineFallsBackWithinTimeout is the
// same regression, for the single-profile fetch (opening the profile
// editor) — getMachineProfile's own offline fallback has the identical
// unbounded-context bug.
func TestGetMachineProfile_UnreachableMachineFallsBackWithinTimeout(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	h := &Handlers{registry: registry, gaggimate: fakeBlockingAdapter{}, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if err := profilesRepo.UpsertSynced(machine.ID, "remote-1", "Cached Profile", json.RawMessage(`{"label":"Cached Profile"}`), false); err != nil {
		t.Fatalf("seeding cached profile: %v", err)
	}

	start := time.Now()
	req := httptest.NewRequest(http.MethodGet, "/api/machine/profile/remote-1?machineId="+strconv.FormatInt(machine.ID, 10), nil)
	rec := doRequest(mux, req)
	elapsed := time.Since(start)

	if elapsed > profileLiveFetchTimeout+3*time.Second {
		t.Fatalf("getMachineProfile took %v against an unreachable machine; want well under %v", elapsed, profileLiveFetchTimeout)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
}
