package machines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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

// fakeBlockingWriteAdapter is fakeBlockingAdapter plus the profile write
// methods: they block exactly like the live reads do (until ctx is done, then
// return ctx.Err()), simulating a GaggiMate that accepts the WebSocket dial but
// then silently stops answering. ProfileEdit is reported so the write routes
// pass requireProfileEditSupport and actually reach the adapter. It is a
// separate type so the read tests keep fakeBlockingAdapter's "not implemented"
// panic if a write method is ever reached from them.
type fakeBlockingWriteAdapter struct{ fakeBlockingAdapter }

var _ Adapter = fakeBlockingWriteAdapter{}

func (fakeBlockingWriteAdapter) Capabilities() Capabilities {
	return Capabilities{ProfileEdit: true}
}

func (fakeBlockingWriteAdapter) CreateProfile(ctx context.Context, m *Machine, in ProfileInput) (ProfileSummary, error) {
	<-ctx.Done()
	return ProfileSummary{}, ctx.Err()
}
func (fakeBlockingWriteAdapter) UpdateProfile(ctx context.Context, m *Machine, in ProfileInput) (ProfileSummary, error) {
	<-ctx.Done()
	return ProfileSummary{}, ctx.Err()
}
func (fakeBlockingWriteAdapter) DeleteProfile(ctx context.Context, m *Machine, id string) ([]ProfileSummary, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// shrinkProfileLiveWriteTimeout replaces the bounded write timeout with a short
// one for the duration of a test, so the write-fallback cases run in
// milliseconds instead of the production 10s. Restored via t.Cleanup.
func shrinkProfileLiveWriteTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	orig := profileLiveWriteTimeout
	profileLiveWriteTimeout = d
	t.Cleanup(func() { profileLiveWriteTimeout = orig })
}

// TestCreateMachineProfile_UnresponsiveGaggiMateFallsBackWithinTimeout is the
// write-side twin of the "profiles disappear after reload" regression:
// CreateProfile used to run on the bare, unbounded r.Context(), so a GaggiMate
// that silently drops packets after the WS dial blocked the handler (and held
// the per-machine profile lock) until the client gave up. It must now fall back
// to a local pending_create row within profileLiveWriteTimeout.
func TestCreateMachineProfile_UnresponsiveGaggiMateFallsBackWithinTimeout(t *testing.T) {
	shrinkProfileLiveWriteTimeout(t, 200*time.Millisecond)

	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	h := &Handlers{registry: registry, gaggimate: fakeBlockingWriteAdapter{}, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	body := `{"label":"Blocked Profile","phases":[{"type":"PRESSURE"}],"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`
	start := time.Now()
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/profile", strings.NewReader(body)))
	elapsed := time.Since(start)

	if elapsed > profileLiveWriteTimeout+3*time.Second {
		t.Fatalf("createMachineProfile took %v against an unresponsive GaggiMate; want well under %v (the bounded write timeout)", elapsed, profileLiveWriteTimeout)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	created := decodeBody(t, rec.Body.Bytes())
	if created["syncStatus"] != ProfileSyncPendingCreate {
		t.Errorf("syncStatus = %v, want %q", created["syncStatus"], ProfileSyncPendingCreate)
	}
	id, _ := created["id"].(string)
	if !strings.HasPrefix(id, "local:") {
		t.Fatalf("id = %q, want a local: placeholder (never synced to the machine)", id)
	}
	row, err := profilesRepo.Get(machine.ID, id)
	if err != nil {
		t.Fatalf("profilesRepo.Get(%q): %v", id, err)
	}
	if row == nil {
		t.Fatalf("no local row stored for %q", id)
	}
	if row.LastSyncError == nil || *row.LastSyncError == "" {
		t.Errorf("expected a sync error recorded on the local row after the failed push, got %+v", row)
	}
}

// TestUpdateMachineProfile_UnresponsiveGaggiMateFallsBackWithinTimeout is the
// update-side twin: a PUT to a GaggiMate that never answers must also return
// within the bound with the local edit kept (200), not hang the handler.
func TestUpdateMachineProfile_UnresponsiveGaggiMateFallsBackWithinTimeout(t *testing.T) {
	shrinkProfileLiveWriteTimeout(t, 200*time.Millisecond)

	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	h := &Handlers{registry: registry, gaggimate: fakeBlockingWriteAdapter{}, profilesRepo: profilesRepo}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if err := profilesRepo.UpsertSynced(machine.ID, "remote-1", "Cached Profile", json.RawMessage(`{"label":"Cached Profile","phases":[{"type":"PRESSURE"}]}`), false); err != nil {
		t.Fatalf("seeding synced profile: %v", err)
	}

	body := `{"label":"Renamed","phases":[{"type":"PRESSURE"}],"machineId":` + strconv.FormatInt(machine.ID, 10) + `}`
	start := time.Now()
	rec := doRequest(mux, httptest.NewRequest(http.MethodPut, "/api/machine/profile/remote-1", strings.NewReader(body)))
	elapsed := time.Since(start)

	if elapsed > profileLiveWriteTimeout+3*time.Second {
		t.Fatalf("updateMachineProfile took %v against an unresponsive GaggiMate; want well under %v", elapsed, profileLiveWriteTimeout)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["syncStatus"] == ProfileSyncSynced {
		t.Errorf("syncStatus = %v, want a not-synced status (push failed, edit kept locally)", updated["syncStatus"])
	}
}
