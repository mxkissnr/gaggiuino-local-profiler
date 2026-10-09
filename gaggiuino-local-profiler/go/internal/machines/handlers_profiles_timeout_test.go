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

// failOnCallAdapter is a machines.Adapter whose live methods fail the test if
// they are ever called. It is the fixture for the #1572 fast-path tests: once
// the poller reports the machine unreachable, both the profiles and the
// firmware-version handlers must answer from local state without touching the
// adapter. Capabilities() is deliberately exempt from failing — the handlers
// consult it to gate the route before the offline check runs.
type failOnCallAdapter struct {
	fakePanicAdapter
	t *testing.T
}

var _ Adapter = failOnCallAdapter{}

func (a failOnCallAdapter) Capabilities() Capabilities {
	return Capabilities{ProfileEdit: true, SettingsProxy: true}
}

func (a failOnCallAdapter) fail(name string) {
	a.t.Fatalf("adapter %s called for a machine the poller already knows is offline (#1572)", name)
}

func (a failOnCallAdapter) GetStatus(context.Context, *Machine) (Status, error) {
	a.fail("GetStatus")
	return Status{}, nil
}
func (a failOnCallAdapter) ListProfiles(context.Context, *Machine) ([]ProfileSummary, error) {
	a.fail("ListProfiles")
	return nil, nil
}
func (a failOnCallAdapter) GetSettings(context.Context, *Machine, string) (json.RawMessage, error) {
	a.fail("GetSettings")
	return nil, nil
}

// recordingProfilesAdapter records that the live reads were reached; it returns
// one remote profile so the live path's response is distinguishable from the
// offline cache fallback (stale false vs true).
type recordingProfilesAdapter struct {
	fakeBlockingAdapter
	statusCalled bool
	listCalled   bool
}

func (a *recordingProfilesAdapter) GetStatus(context.Context, *Machine) (Status, error) {
	a.statusCalled = true
	return Status{}, nil
}
func (a *recordingProfilesAdapter) ListProfiles(context.Context, *Machine) ([]ProfileSummary, error) {
	a.listCalled = true
	return []ProfileSummary{{ID: "remote-1", Name: "Cached Profile"}}, nil
}

// TestListMachineProfiles_KnownOfflineAnswersFromCacheWithoutAdapter is the
// #1572 regression test: once the poller reports the machine unreachable,
// GET /api/machine/profiles must answer from the local cache immediately --
// same shape as the existing post-failure fallback (cached rows, stale: true,
// no current profile) -- and never call the adapter.
func TestListMachineProfiles_KnownOfflineAnswersFromCacheWithoutAdapter(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	profilesRepo := NewProfilesRepository(sqlDB)
	h := &Handlers{registry: registry, gaggimate: failOnCallAdapter{t: t}, profilesRepo: profilesRepo}
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
	h.SetKnownUnreachable(func(id int64) bool { return id == machine.ID })

	start := time.Now()
	rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil))
	if elapsed := time.Since(start); elapsed > profileLiveFetchTimeout {
		t.Fatalf("listMachineProfiles took %v for a known-offline machine; want an immediate cache answer, well under %v", elapsed, profileLiveFetchTimeout)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["stale"] != true {
		t.Errorf("stale = %v, want true (served from the local cache)", body["stale"])
	}
	if body["current"] != nil || body["currentId"] != nil {
		t.Errorf("current/currentId = %v/%v, want nil/nil (machine known offline)", body["current"], body["currentId"])
	}
	optionsRaw, _ := body["optionsRaw"].([]any)
	if len(optionsRaw) != 1 {
		t.Fatalf("expected 1 cached profile, got %d: %+v", len(optionsRaw), body)
	}
}

// TestListMachineProfiles_ReachableOrUnknownStillGoesLive is the converse of
// the test above: a nil hook, or a hook that reports the machine online, must
// leave the live path untouched -- the adapter is called and the response
// reflects the live list (stale false), not the local-cache fallback.
func TestListMachineProfiles_ReachableOrUnknownStillGoesLive(t *testing.T) {
	for _, tc := range []struct {
		name string
		hook func(*Handlers, int64)
	}{
		{"nil hook", func(h *Handlers, _ int64) { h.SetKnownUnreachable(nil) }},
		{"reports online", func(h *Handlers, _ int64) { h.SetKnownUnreachable(func(int64) bool { return false }) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			registry, sqlDB := newTestRegistry(t)
			profilesRepo := NewProfilesRepository(sqlDB)
			adapter := &recordingProfilesAdapter{}
			h := &Handlers{registry: registry, gaggimate: adapter, profilesRepo: profilesRepo}
			mux := newMux(h)

			machine, err := registry.CreateMachine(MachineInput{
				Name: strPtr("Fake GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
			})
			if err != nil {
				t.Fatalf("CreateMachine: %v", err)
			}
			tc.hook(h, machine.ID)

			rec := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machine.ID, 10), nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
			}
			if !adapter.statusCalled || !adapter.listCalled {
				t.Fatalf("adapter calls: status=%v list=%v, want both true (live path preserved)", adapter.statusCalled, adapter.listCalled)
			}
			body := decodeBody(t, rec.Body.Bytes())
			if body["stale"] != false {
				t.Errorf("stale = %v, want false (live path)", body["stale"])
			}
		})
	}
}

