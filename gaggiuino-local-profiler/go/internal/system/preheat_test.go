package system

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
)

// markLivePollingActive flags live polling as running without spawning the
// ticker goroutine, so applyStandbyTransition tests stay deterministic while
// still exercising its #1498 "live polling must be active" guard.
func markLivePollingActive(t *testing.T, p *Poller) {
	t.Helper()
	p.liveMu.Lock()
	p.liveTicker = time.NewTicker(time.Hour)
	p.liveStop = make(chan struct{})
	p.liveMu.Unlock()
	t.Cleanup(func() {
		p.liveMu.Lock()
		if p.liveTicker != nil {
			p.liveTicker.Stop()
			close(p.liveStop)
			p.liveTicker = nil
		}
		p.liveMu.Unlock()
	})
}

// TestBuildPreheatResponse_ActivePreheat exercises buildPreheatResponse's
// "machine on, mid-preheat" branch — elapsed/remaining/pct must move
// together and stabilityReady must be present (even if false) once a
// switchOnAt exists.
func TestBuildPreheatResponse_ActivePreheat(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	onAt := time.Now().UnixMilli() - 5*60_000 // 5 minutes ago
	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(&onAt)

	status := p.PreheatStatus()
	if status.Ready {
		t.Error("Ready = true, want false (only 5 of 20 default minutes elapsed)")
	}
	if status.Elapsed < 299 || status.Elapsed > 301 {
		t.Errorf("Elapsed = %d, want ~300s", status.Elapsed)
	}
	if status.StabilityReady == nil {
		t.Error("StabilityReady should be present (non-nil) once switchOnAt is set")
	}
	if status.Pct <= 0 || status.Pct >= 1 {
		t.Errorf("Pct = %v, want strictly between 0 and 1", status.Pct)
	}
}

// TestBuildPreheatResponse_ReadyOnceElapsedExceedsPreheatTime.
func TestBuildPreheatResponse_ReadyOnceElapsedExceedsPreheatTime(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	onAt := time.Now().UnixMilli() - 21*60_000 // past the 20-minute default
	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(&onAt)

	status := p.PreheatStatus()
	if !status.Ready {
		t.Error("Ready = false, want true once elapsed exceeds preheatTime")
	}
	if status.Remaining != 0 {
		t.Errorf("Remaining = %d, want 0", status.Remaining)
	}
}

// TestSetReadyByTarget_RoundTrip exercises SetReadyByTarget's
// targetAt -> plannedSwitchOnAt derivation and the null-clears path.
func TestSetReadyByTarget_RoundTrip(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	target := time.Now().UnixMilli() + 30*60_000
	p.SetReadyByTarget(&target)

	status := p.PreheatStatus()
	if status.ReadyByTargetAt == nil || *status.ReadyByTargetAt != target {
		t.Fatalf("ReadyByTargetAt = %v, want %d", status.ReadyByTargetAt, target)
	}
	wantPlanned := target - int64(loadPreheatMinutes())*60_000
	if status.PlannedSwitchOnAt == nil || *status.PlannedSwitchOnAt != wantPlanned {
		t.Fatalf("PlannedSwitchOnAt = %v, want %d", status.PlannedSwitchOnAt, wantPlanned)
	}

	p.SetReadyByTarget(nil)
	status = p.PreheatStatus()
	if status.ReadyByTargetAt != nil || status.PlannedSwitchOnAt != nil {
		t.Errorf("expected both fields nil after clearing, got %v / %v", status.ReadyByTargetAt, status.PlannedSwitchOnAt)
	}
}

// TestCheckReadyByPreheat_FiresSwitchOnAndClearsTarget exercises
// _checkReadyByPreheat's one-shot auto turn-on.
func TestCheckReadyByPreheat_FiresSwitchOnAndClearsTarget(t *testing.T) {
	var calledPath string
	haSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer haSrv.Close()
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", haSrv.URL)
	t.Setenv("GLP_HA_TOKEN", "test-token")
	haClient := ha.NewClientFromEnv()

	fake := &fakeAdapter{}
	sqlDB := newTestDB(t)
	registryDeps := newTestPollerWithHA(t, fake, sqlDB, haClient, "switch.machine")
	p := registryDeps

	past := time.Now().UnixMilli() - 1000
	p.SetReadyByTarget(nil) // no-op, ensures clean state
	p.state.mu.Lock()
	target := past + 60_000
	planned := past
	p.state.readyByTargetAt = &target
	p.state.plannedSwitchOnAt = &planned
	p.state.mu.Unlock()

	p.checkReadyByPreheat(context.Background())

	if calledPath != "/api/services/switch/turn_on" {
		t.Fatalf("HA path called = %q, want /api/services/switch/turn_on", calledPath)
	}
	status := p.PreheatStatus()
	if status.ReadyByTargetAt != nil || status.PlannedSwitchOnAt != nil {
		t.Error("expected the ready-by target to be cleared after firing")
	}
}

// TestBuildPreheatResponse_StandbyNoSwitchEntity pins #1498: with no switch
// entity configured, a machine that reports standby must read as off — ready
// false, elapsed 0, standby true — even once the preheat time has elapsed.
func TestBuildPreheatResponse_StandbyNoSwitchEntity(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	onAt := time.Now().UnixMilli() - 21*60_000 // past the 20-minute default
	p.runtime.SetSwitchOnAt(&onAt)
	p.runtime.SetStandby(true)

	status := p.PreheatStatus()
	if status.Ready {
		t.Error("Ready = true, want false while the machine is in standby")
	}
	if status.Elapsed != 0 {
		t.Errorf("Elapsed = %d, want 0 while the machine is in standby", status.Elapsed)
	}
	if !status.Standby {
		t.Error("Standby = false, want true")
	}
}

// TestBuildPreheatResponse_NoSwitchNoStandby_CountdownRuns is the Gaggiuino
// case: with no switch entity and no standby signal, behaviour is unchanged —
// the switchOnAt countdown still drives the response, so a switch-less
// Gaggiuino is not mistaken for "off". Without this, gating on MachineOn (never
// set when no switch entity is configured) would break every switch-less
// install (#1498).
func TestBuildPreheatResponse_NoSwitchNoStandby_CountdownRuns(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	onAt := time.Now().UnixMilli() - 5*60_000 // 5 of the 20 default minutes
	p.runtime.SetMachineOn(false)
	p.runtime.SetStandby(false)
	p.runtime.SetSwitchOnAt(&onAt)

	status := p.PreheatStatus()
	if status.Ready {
		t.Error("Ready = true, want false (5 of 20 minutes elapsed)")
	}
	if status.Standby {
		t.Error("Standby = true, want false")
	}
	if status.Elapsed < 299 || status.Elapsed > 301 {
		t.Errorf("Elapsed = %d, want ~300s (switch-less countdown must still run)", status.Elapsed)
	}
}

// TestApplyStandbyTransition_LeaveResetsClock pins #1498's wake-up path: a cold
// machine leaving standby restarts the preheat clock from now, so the countdown
// begins at zero instead of inheriting the pre-standby switchOnAt.
func TestApplyStandbyTransition_LeaveResetsClock(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)
	markLivePollingActive(t, p)

	cold := 30.0
	old := int64(0)
	p.runtime.SetCurrentTemps(&cold, nil)
	p.runtime.SetSwitchOnAt(&old)
	p.runtime.SetStandby(true)

	p.applyStandbyTransition(time.Now().UnixMilli(), false)

	snap := p.runtime.Get()
	if snap.Standby {
		t.Error("Standby = true, want false after leaving standby")
	}
	if snap.SwitchOnAt == nil || time.Now().UnixMilli()-*snap.SwitchOnAt > 2000 {
		t.Errorf("SwitchOnAt = %v, want reset to ~now for a cold machine", snap.SwitchOnAt)
	}
	status := p.PreheatStatus()
	if status.Ready {
		t.Error("Ready = true, want false right after the clock restarts")
	}
	if status.Elapsed < 0 || status.Elapsed > 2 {
		t.Errorf("Elapsed = %d, want ~0 (countdown restarted)", status.Elapsed)
	}
}

// TestApplyStandbyTransition_EnterResetsPreheatState pins the standby-entry
// bookkeeping (#1498): entering standby must mirror the switch-off path — close
// the open preheat run, clear the stability flag and the temp history — so a
// wake-up cannot report stabilityReady from a stale pre-standby session and the
// history is not polluted with cold standby samples.
func TestApplyStandbyTransition_EnterResetsPreheatState(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)
	markLivePollingActive(t, p)

	onAt := time.Now().UnixMilli() - 5*60_000
	p.runtime.SetSwitchOnAt(&onAt)
	p.openPreheatRun(onAt)
	p.runtime.SetStabilityReady(true)
	for i := 0; i < tempStableMin; i++ {
		p.runtime.PushTempHistory(92.0)
	}
	if !p.runtime.IsTempStable() {
		t.Fatal("precondition: temp history should read as stable")
	}

	p.applyStandbyTransition(time.Now().UnixMilli(), true)

	snap := p.runtime.Get()
	if !snap.Standby {
		t.Error("Standby = false, want true after entering standby")
	}
	if snap.StabilityReady {
		t.Error("StabilityReady = true, want false (stale stability must clear on standby)")
	}
	if snap.SwitchOffAt == nil {
		t.Error("SwitchOffAt = nil, want set on entering standby")
	}
	if p.runtime.IsTempStable() {
		t.Error("temp history should be cleared on entering standby")
	}
	runs := p.PreheatHistory()
	if len(runs) == 0 {
		t.Fatal("expected the open preheat run to be closed and recorded")
	}
	if runs[0].SwitchOffAt == nil {
		t.Error("newest run is still open, want it closed on entering standby")
	}
}

// TestApplyStandbyTransition_WakeHotBoilerStartsNewSession pins the #1498
// review fix: a hot boiler waking from a short standby must still start a new
// preheat session. GaggiMate turns its heater off in standby, so keeping the
// pre-standby clock would understate the warm-up; the old IsStillWarm shortcut
// is gone and ready must read false right after waking.
func TestApplyStandbyTransition_WakeHotBoilerStartsNewSession(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)
	markLivePollingActive(t, p)

	hot := 90.0
	old := time.Now().UnixMilli() - 30*60_000
	offAt := time.Now().UnixMilli() - 60_000 // 1 minute of standby (< 5)
	p.runtime.SetCurrentTemps(&hot, nil)
	p.runtime.SetSwitchOnAt(&old)
	p.runtime.SetSwitchOffAt(&offAt)
	p.runtime.SetStandby(true)
	if !p.runtime.IsStillWarm(time.Now().UnixMilli()) {
		t.Fatal("precondition: a hot boiler after a short standby should read as still warm")
	}

	before := len(p.PreheatHistory())
	p.applyStandbyTransition(time.Now().UnixMilli(), false)

	snap := p.runtime.Get()
	if snap.Standby {
		t.Error("Standby = true, want false after leaving standby")
	}
	if snap.SwitchOnAt == nil || *snap.SwitchOnAt == old {
		t.Fatalf("SwitchOnAt = %v, want a fresh value, not the pre-standby %d", snap.SwitchOnAt, old)
	}
	if time.Now().UnixMilli()-*snap.SwitchOnAt > 2000 {
		t.Errorf("SwitchOnAt = %v, want reset to ~now even for a hot boiler", snap.SwitchOnAt)
	}
	runs := p.PreheatHistory()
	if len(runs) <= before {
		t.Fatalf("history len = %d, want a new run opened (was %d)", len(runs), before)
	}
	if runs[0].SwitchOffAt != nil {
		t.Error("newest run should be open right after waking")
	}
	if status := p.PreheatStatus(); status.Ready {
		t.Error("Ready = true, want false right after waking")
	}
}

// TestApplyStandbyTransition_NoLivePollingNoop pins the #1498 review fix:
// applyStandbyTransition must do nothing once live polling has stopped, so a
// late status can never open a run or move the clock after stopLivePolling
// ended the session.
func TestApplyStandbyTransition_NoLivePollingNoop(t *testing.T) {
	fake := &fakeAdapter{}
	p := newPreheatHistoryPoller(t, fake)

	old := time.Now().UnixMilli() - 30*60_000
	p.runtime.SetSwitchOnAt(&old)
	before := len(p.PreheatHistory())

	p.applyStandbyTransition(time.Now().UnixMilli(), true)

	snap := p.runtime.Get()
	if snap.Standby {
		t.Error("Standby = true, want false (transition must no-op without live polling)")
	}
	if snap.SwitchOnAt == nil || *snap.SwitchOnAt != old {
		t.Errorf("SwitchOnAt = %v, want unchanged %d", snap.SwitchOnAt, old)
	}
	if got := len(p.PreheatHistory()); got != before {
		t.Errorf("history len = %d, want unchanged %d", got, before)
	}
}
