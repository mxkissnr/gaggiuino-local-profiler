package system

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// pollDefault drives one live-poll tick with a healthy default machine.
func pollDefault(t *testing.T, p *Poller, fake *fakeAdapter) {
	t.Helper()
	fake.setStatus(okStatus(t, `{"softwareVersion":"1.0.0"}`, 93, 94, 1, 0, false, "Espresso", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
}

// TestFirmwareName_FetchedOnceAndCached is the #1454 core proof: the machine
// name the firmware reports in its system settings surfaces as
// MachineStatus(...).FirmwareName, and the extra settings GET happens once per
// reachable stretch, not once per 1s poll tick.
func TestFirmwareName_FetchedOnceAndCached(t *testing.T) {
	p, _, fake, _ := newMultiMachinePoller(t)
	fake.setSettings(json.RawMessage(`{"machineName":"GC-01"}`), nil)

	for i := 0; i < 3; i++ {
		pollDefault(t, p, fake)
	}

	st := p.MachineStatus(1)
	if st.FirmwareName == nil || *st.FirmwareName != "GC-01" {
		t.Fatalf("FirmwareName = %v, want GC-01", st.FirmwareName)
	}
	if got := fake.settingsCalls(); got != 1 {
		t.Errorf("GetSettings calls = %d, want 1", got)
	}
}

// TestFirmwareName_EmptySettingsCachesNil covers firmware that reports no name
// (or is too old to have one): the result is nil, but it is still fetched only
// once — an empty answer is a completed fetch, not a retry trigger.
func TestFirmwareName_EmptySettingsCachesNil(t *testing.T) {
	p, _, fake, _ := newMultiMachinePoller(t)
	fake.setSettings(json.RawMessage(`{}`), nil)

	for i := 0; i < 3; i++ {
		pollDefault(t, p, fake)
	}

	if st := p.MachineStatus(1); st.FirmwareName != nil {
		t.Errorf("FirmwareName = %v, want nil", st.FirmwareName)
	}
	if got := fake.settingsCalls(); got != 1 {
		t.Errorf("GetSettings calls = %d, want 1", got)
	}
}

// TestFirmwareName_ErrorRetriedAtMostEvery60s proves a failed settings fetch is
// retried on a later tick, but throttled: the 1s tick cadence must never become
// one extra HTTP request per second while the settings endpoint is down.
func TestFirmwareName_ErrorRetriedAtMostEvery60s(t *testing.T) {
	p, _, fake, _ := newMultiMachinePoller(t)
	fake.setSettings(nil, errBoom)

	pollDefault(t, p, fake)
	if got := fake.settingsCalls(); got != 1 {
		t.Fatalf("GetSettings calls after first poll = %d, want 1", got)
	}
	pollDefault(t, p, fake)
	if got := fake.settingsCalls(); got != 1 {
		t.Errorf("GetSettings calls after immediate retry = %d, want 1 (throttled)", got)
	}

	// Simulate the retry window elapsing: the next tick tries again.
	p.state.mu.Lock()
	p.state.machine(1).firmwareNameAttempt = time.Now().Add(-61 * time.Second).UnixMilli()
	p.state.mu.Unlock()
	pollDefault(t, p, fake)
	if got := fake.settingsCalls(); got != 2 {
		t.Errorf("GetSettings calls after 60s = %d, want 2", got)
	}
	if st := p.MachineStatus(1); st.FirmwareName != nil {
		t.Errorf("FirmwareName = %v, want nil after a failed fetch", st.FirmwareName)
	}
}

// TestFirmwareName_GaggiMateNeverFetches: a GaggiMate has no firmware machine
// name, so the settings proxy is never touched for it.
func TestFirmwareName_GaggiMateNeverFetches(t *testing.T) {
	p, registry, fake, _ := newMultiMachinePoller(t)
	typ := "gaggimate"
	if _, err := registry.UpdateMachine(1, machines.MachineInput{Type: &typ}, nil); err != nil {
		t.Fatalf("UpdateMachine(type=gaggimate): %v", err)
	}

	for i := 0; i < 3; i++ {
		pollDefault(t, p, fake)
	}

	if got := fake.settingsCalls(); got != 0 {
		t.Errorf("GetSettings calls for a GaggiMate = %d, want 0", got)
	}
	if st := p.MachineStatus(1); st.FirmwareName != nil {
		t.Errorf("FirmwareName = %v, want nil for a GaggiMate", st.FirmwareName)
	}
}

// TestFirmwareName_ResetOnRecovery proves an unreachable->reachable transition
// re-arms the fetch, so a machine renamed while it was away is picked up.
func TestFirmwareName_ResetOnRecovery(t *testing.T) {
	p, _, fake, _ := newMultiMachinePoller(t)
	fake.setSettings(json.RawMessage(`{"machineName":"GC-01"}`), nil)
	pollDefault(t, p, fake)
	if st := p.MachineStatus(1); st.FirmwareName == nil || *st.FirmwareName != "GC-01" {
		t.Fatalf("setup: FirmwareName = %v, want GC-01", st.FirmwareName)
	}

	// The machine goes away, is renamed, and comes back.
	fake.setStatus(machinesStatusZero(), errBoom)
	p.pollViaGaggiuinoStatus(context.Background())
	fake.setSettings(json.RawMessage(`{"machineName":"GC-02"}`), nil)
	pollDefault(t, p, fake)

	if st := p.MachineStatus(1); st.FirmwareName == nil || *st.FirmwareName != "GC-02" {
		t.Errorf("FirmwareName after rename+recovery = %v, want GC-02", st.FirmwareName)
	}
	if got := fake.settingsCalls(); got != 2 {
		t.Errorf("GetSettings calls = %d, want 2 (once per reachable stretch)", got)
	}
}

// TestBuildStatusMachines_CopiesFirmwareName: the poll state's FirmwareName
// projects onto GET /api/status's machines[] entry.
func TestBuildStatusMachines_CopiesFirmwareName(t *testing.T) {
	name := "GC-01"
	list := []machines.Machine{{ID: 1, Name: "Kitchen", Type: "gaggiuino", IsDefault: true}}
	out := buildStatusMachines(list, nil, false, true, func(int64) MachinePollStatus {
		return MachinePollStatus{FirmwareName: &name}
	})
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1", len(out))
	}
	if out[0].FirmwareName == nil || *out[0].FirmwareName != "GC-01" {
		t.Errorf("FirmwareName = %v, want GC-01", out[0].FirmwareName)
	}
}
