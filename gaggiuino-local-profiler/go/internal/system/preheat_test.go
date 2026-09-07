package system

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
)

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
