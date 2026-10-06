package system

import (
	"context"
	"database/sql"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// machine_control_live_test.go covers #1324's live-payload half: the
// machineControl field GET /api/live/data (and the live-snapshot SSE payload)
// carries for the default machine, sourced from machines.ControlStateFor on
// every successful poll. The flush/confirm endpoints themselves live in
// internal/machines.

// fakeControlAdapter is fakeAdapter plus the opt-in machine-control surface:
// Capabilities().MachineControl is true and it satisfies
// machines.MachineController with a canned ControlState, so ControlStateFor's
// capability/setting/availability gates all pass.
type fakeControlAdapter struct {
	fakeAdapter
	state machines.ControlState
}

var _ machines.MachineController = (*fakeControlAdapter)(nil)

func (f *fakeControlAdapter) Capabilities() machines.Capabilities {
	return machines.Capabilities{MachineControl: true}
}

func (f *fakeControlAdapter) ControlState(*machines.Machine) (machines.ControlState, bool) {
	return f.state, true
}

func (f *fakeControlAdapter) FlushStart(context.Context, *machines.Machine) error { return nil }
func (f *fakeControlAdapter) FlushStop(context.Context, *machines.Machine) error  { return nil }
func (f *fakeControlAdapter) ConfirmBrew(context.Context, *machines.Machine) error {
	return nil
}
func (f *fakeControlAdapter) CancelBrewConfirm(context.Context, *machines.Machine) error {
	return nil
}

// adapterProviderFunc adapts a function to this package's AdapterProvider, so
// these tests can inject a non-*fakeAdapter (fakeControlAdapter) without
// touching helpers_test.go's fakeAdapterProvider.
type adapterProviderFunc func(*machines.Machine) (machines.Adapter, error)

func (f adapterProviderFunc) GetAdapter(m *machines.Machine) (machines.Adapter, error) {
	return f(m)
}

// newMachineControlPoller mirrors helpers_test.go's newTestPoller but accepts
// any machines.Adapter and returns the registry (so a test can flip the opt-in
// setting) and the DB (for the HTTP handler).
func newMachineControlPoller(t *testing.T, adapter machines.Adapter) (*Poller, *machines.Registry, *sql.DB) {
	t.Helper()
	sqlDB := newTestDB(t)
	registry := machines.NewRegistry(sqlDB)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	host := "fake-machine.invalid"
	if _, err := registry.UpdateMachine(1, machines.MachineInput{Host: &host}, nil); err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	prov := adapterProviderFunc(func(*machines.Machine) (machines.Adapter, error) { return adapter, nil })
	return NewPoller(registry, prov, newHubForTest(), newDisabledHAClient()), registry, sqlDB
}

// TestMachineControl_LiveDataEnabled: with the opt-in setting on, one poll
// tick makes GET /api/live/data carry the adapter's snapshot with the default
// machine's id and the canned flags plus brewConfirm.
func TestMachineControl_LiveDataEnabled(t *testing.T) {
	fake := &fakeControlAdapter{state: machines.ControlState{
		CanFlush:    true,
		Flushing:    true,
		BrewConfirm: []string{"flush_warning"},
	}}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 18, false, "Espresso", 1), nil)
	p, registry, sqlDB := newMachineControlPoller(t, fake)
	if err := registry.SetMachineControlEnabled(true); err != nil {
		t.Fatalf("SetMachineControlEnabled: %v", err)
	}

	p.pollViaGaggiuinoStatus(context.Background())

	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, nil, nil), testAPIToken))
	body := decodeMap(t, doGet(mux, "/api/live/data").Body.Bytes())
	mc, ok := body["machineControl"].(map[string]any)
	if !ok {
		t.Fatalf("machineControl = %v (%T), want an object", body["machineControl"], body["machineControl"])
	}
	if mc["machineId"] != float64(1) {
		t.Errorf("machineId = %v, want 1 (the default machine)", mc["machineId"])
	}
	if mc["canFlush"] != true || mc["flushing"] != true {
		t.Errorf("flags = %v, want canFlush and flushing true", mc)
	}
	bc, ok := mc["brewConfirm"].([]any)
	if !ok || len(bc) != 1 || bc[0] != "flush_warning" {
		t.Errorf("brewConfirm = %v, want [flush_warning]", mc["brewConfirm"])
	}
}

// TestMachineControl_LiveDataSettingOffIsNull: a machine-control-capable
// adapter still reports null while the opt-in setting is off.
func TestMachineControl_LiveDataSettingOffIsNull(t *testing.T) {
	fake := &fakeControlAdapter{state: machines.ControlState{CanFlush: true}}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 18, false, "Espresso", 1), nil)
	p, _, _ := newMachineControlPoller(t, fake)

	p.pollViaGaggiuinoStatus(context.Background())

	if ld := p.LiveData(); ld.MachineControl != nil {
		t.Errorf("MachineControl = %+v, want nil while the opt-in setting is off", ld.MachineControl)
	}
}

// TestMachineControl_LiveDataClearedOnStatusError: a failed GetStatus clears a
// previously-populated snapshot.
func TestMachineControl_LiveDataClearedOnStatusError(t *testing.T) {
	fake := &fakeControlAdapter{state: machines.ControlState{CanFlush: true}}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 18, false, "Espresso", 1), nil)
	p, registry, _ := newMachineControlPoller(t, fake)
	if err := registry.SetMachineControlEnabled(true); err != nil {
		t.Fatalf("SetMachineControlEnabled: %v", err)
	}

	p.pollViaGaggiuinoStatus(context.Background())
	if p.LiveData().MachineControl == nil {
		t.Fatal("precondition: want a snapshot after a successful poll")
	}

	fake.setStatus(machinesStatusZero(), errBoom)
	p.pollViaGaggiuinoStatus(context.Background())

	if ld := p.LiveData(); ld.MachineControl != nil {
		t.Errorf("MachineControl = %+v, want nil after a GetStatus error", ld.MachineControl)
	}
}

// TestMachineControl_LiveDataUnsupportedIsNull: a Gaggiuino-like adapter
// reports null even with the setting on, because it has no machine control.
func TestMachineControl_LiveDataUnsupportedIsNull(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 18, false, "Espresso", 1), nil)
	p, registry, _ := newMachineControlPoller(t, fake)
	if err := registry.SetMachineControlEnabled(true); err != nil {
		t.Fatalf("SetMachineControlEnabled: %v", err)
	}

	p.pollViaGaggiuinoStatus(context.Background())

	if ld := p.LiveData(); ld.MachineControl != nil {
		t.Errorf("MachineControl = %+v, want nil for an adapter without machine control", ld.MachineControl)
	}
}
