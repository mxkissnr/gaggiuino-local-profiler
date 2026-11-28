package system

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newPreheatHistoryPoller points preheatHistoryFile at a throwaway file
// (restored on cleanup) and returns a poller around the given fake adapter.
func newPreheatHistoryPoller(t *testing.T, fake *fakeAdapter) *Poller {
	t.Helper()
	orig := preheatHistoryFile
	preheatHistoryFile = filepath.Join(t.TempDir(), "preheat_history.json")
	t.Cleanup(func() { preheatHistoryFile = orig })
	p, _ := newTestPoller(t, fake)
	return p
}

// TestPreheatHistory_LifecycleOpenToClose drives the real hook points through
// startLivePolling/stopLivePolling: starting opens one run, stopping closes it
// and persists it.
func TestPreheatHistory_LifecycleOpenToClose(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	t.Cleanup(p.stopLivePolling)

	p.startLivePolling()

	h := p.PreheatHistory()
	if len(h) != 1 {
		t.Fatalf("history len = %d, want 1 open run", len(h))
	}
	run := h[0]
	if run.SwitchOffAt != nil {
		t.Error("open run should have SwitchOffAt nil")
	}
	if run.SwitchOnAt == 0 {
		t.Error("SwitchOnAt not set on the open run")
	}
	if run.PreheatMinutes != loadPreheatMinutes() {
		t.Errorf("PreheatMinutes = %d, want %d", run.PreheatMinutes, loadPreheatMinutes())
	}
	if run.PredictedReadyAt != run.SwitchOnAt+int64(run.PreheatMinutes)*60_000 {
		t.Errorf("PredictedReadyAt = %d, want SwitchOnAt + minutes", run.PredictedReadyAt)
	}
	if len(run.Samples) != 0 {
		t.Errorf("open run samples = %d, want 0", len(run.Samples))
	}

	p.stopLivePolling()

	h = p.PreheatHistory()
	if len(h) != 1 {
		t.Fatalf("history len after close = %d, want 1", len(h))
	}
	if h[0].SwitchOffAt == nil {
		t.Error("closed run should have SwitchOffAt set")
	}

	data, err := os.ReadFile(preheatHistoryFile)
	if err != nil {
		t.Fatalf("read history file: %v", err)
	}
	var runs []PreheatRun
	if err := json.Unmarshal(data, &runs); err != nil {
		t.Fatalf("unmarshal history file: %v", err)
	}
	if len(runs) != 1 || runs[0].SwitchOnAt != h[0].SwitchOnAt {
		t.Fatalf("persisted runs = %+v, want the one closed run", runs)
	}
}

// TestPreheatHistory_SamplesSpacingAndStable pins the 30s spacing, the
// zero-temp skip, and that stabilising stamps StableAt without moving the
// run's own real switch-on time.
func TestPreheatHistory_SamplesSpacingAndStable(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	base := time.Now().UnixMilli()
	p.openPreheatRun(1, base)

	p.recordPreheatSample(1, base, 0, 93)           // temp 0 -> skipped
	p.recordPreheatSample(1, base, 90, 93)          // first sample
	p.recordPreheatSample(1, base+10_000, 91, 93)   // < 30s -> skipped
	p.recordPreheatSample(1, base+30_000, 92, 93)   // 30s -> appended
	p.recordPreheatSample(1, base+45_000, 92.5, 93) // < 30s -> skipped
	p.recordPreheatSample(1, base+60_000, 93, 93)   // appended

	run := p.PreheatHistory()[0]
	if len(run.Samples) != 3 {
		t.Fatalf("samples = %d, want 3", len(run.Samples))
	}
	for i, want := range []float64{0, 30, 60} {
		if run.Samples[i].TS != want {
			t.Errorf("sample %d TS = %v, want %v", i, run.Samples[i].TS, want)
		}
	}

	p.markPreheatStable(1, base+60_000)
	run = p.PreheatHistory()[0]
	if run.StableAt == nil || *run.StableAt != base+60_000 {
		t.Fatalf("StableAt = %v, want %d", run.StableAt, base+60_000)
	}
	if run.SwitchOnAt != base {
		t.Fatalf("run SwitchOnAt = %d, want the real %d", run.SwitchOnAt, base)
	}

	p.recordPreheatSample(1, base+90_000, 93, 93)
	if got := len(p.PreheatHistory()[0].Samples); got != 3 {
		t.Fatalf("samples after stable = %d, want 3", got)
	}
}

// TestPreheatHistory_SampleCap fills a run to the cap with the last sample
// exactly one interval old, so only the cap can stop the next append.
func TestPreheatHistory_SampleCap(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	now := time.Now().UnixMilli()
	p.openPreheatRun(1, now)

	p.preheatHist.open[1].Samples = make([]PreheatSample, preheatHistoryMaxSamples)
	p.recordPreheatSample(1, now+preheatSampleIntervalMS, 93, 93)

	if got := len(p.PreheatHistory()[0].Samples); got != preheatHistoryMaxSamples {
		t.Fatalf("samples = %d, want cap %d", got, preheatHistoryMaxSamples)
	}
}

// TestPreheatHistory_RunCapAndReload closes more runs than the cap and checks
// only the newest 30 survive, then that a fresh poller reloads them from disk
// in the same order.
func TestPreheatHistory_RunCapAndReload(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	base := time.Now().UnixMilli()
	total := preheatHistoryMaxRuns + 5
	for i := 0; i < total; i++ {
		at := base + int64(i)*60_000
		p.openPreheatRun(1, at)
		p.closePreheatRun(1, at+30_000)
	}

	h := p.PreheatHistory()
	if len(h) != preheatHistoryMaxRuns {
		t.Fatalf("history len = %d, want %d", len(h), preheatHistoryMaxRuns)
	}
	wantNewest := base + int64(total-1)*60_000
	if h[0].SwitchOnAt != wantNewest {
		t.Fatalf("newest SwitchOnAt = %d, want %d", h[0].SwitchOnAt, wantNewest)
	}

	reloaded, _ := newTestPoller(t, &fakeAdapter{})
	h2 := reloaded.PreheatHistory()
	if len(h2) != preheatHistoryMaxRuns {
		t.Fatalf("reloaded history len = %d, want %d", len(h2), preheatHistoryMaxRuns)
	}
	for i := range h2 {
		if h2[i].SwitchOnAt != h[i].SwitchOnAt {
			t.Fatalf("reloaded run %d SwitchOnAt = %d, want %d", i, h2[i].SwitchOnAt, h[i].SwitchOnAt)
		}
	}
	if h2[0].SwitchOffAt == nil {
		t.Error("reloaded run should keep its switchOffAt")
	}
}

// TestPreheatHistory_NewestFirstOpenFirst checks the ordering
// PreheatHistory promises: the open run first, then closed runs newest-first.
func TestPreheatHistory_NewestFirstOpenFirst(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	p.openPreheatRun(1, 1000)
	p.closePreheatRun(1, 2000)
	p.openPreheatRun(1, 3000)
	p.closePreheatRun(1, 4000)
	p.openPreheatRun(1, 5000)

	h := p.PreheatHistory()
	if len(h) != 3 {
		t.Fatalf("history len = %d, want 3", len(h))
	}
	if h[0].SwitchOffAt != nil || h[0].SwitchOnAt != 5000 {
		t.Fatalf("h[0] = %+v, want the open 5000 run", h[0])
	}
	if h[1].SwitchOnAt != 3000 || h[2].SwitchOnAt != 1000 {
		t.Fatalf("closed order = %d,%d, want 3000,1000", h[1].SwitchOnAt, h[2].SwitchOnAt)
	}
}

// TestPreheatHistory_ReturnsCopy proves the exported getter can't be used to
// mutate the poller's internal state.
func TestPreheatHistory_ReturnsCopy(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	p.openPreheatRun(1, 1000)
	p.recordPreheatSample(1, 1000, 90, 93)

	h := p.PreheatHistory()
	h[0].SwitchOnAt = 7
	h[0].Samples[0].TempC = 999

	again := p.PreheatHistory()
	if again[0].SwitchOnAt != 1000 || again[0].Samples[0].TempC != 90 {
		t.Fatalf("internal state mutated through the returned copy: %+v", again[0])
	}
}

// TestPreheatHistory_ReadyByPairAttached covers the lastReadyBy hand-off: a run
// opening shortly after the planned switch-on claims the pair once, and the
// next run does not inherit it.
func TestPreheatHistory_ReadyByPairAttached(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	planned := int64(100_000)
	target := planned + 20*60_000
	p.rememberLastReadyBy(1, &target, &planned)

	p.openPreheatRun(1, planned+5*60_000)
	run := p.PreheatHistory()[0]
	if run.ReadyByTargetAt == nil || *run.ReadyByTargetAt != target {
		t.Fatalf("ReadyByTargetAt = %v, want %d", run.ReadyByTargetAt, target)
	}
	if run.PlannedSwitchOnAt == nil || *run.PlannedSwitchOnAt != planned {
		t.Fatalf("PlannedSwitchOnAt = %v, want %d", run.PlannedSwitchOnAt, planned)
	}

	p.closePreheatRun(1, planned+6*60_000)
	p.openPreheatRun(1, planned+7*60_000)
	if r := p.PreheatHistory()[0]; r.ReadyByTargetAt != nil || r.PlannedSwitchOnAt != nil {
		t.Fatalf("second run inherited the pair: %+v", r)
	}
}

// TestPreheatHistory_ReadyByPairOutsideWindowDropped checks a pair older than
// the 15-minute window is not attributed and is cleared rather than kept.
func TestPreheatHistory_ReadyByPairOutsideWindowDropped(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	planned := int64(1_000_000)
	target := planned + 20*60_000
	p.rememberLastReadyBy(1, &target, &planned)

	p.openPreheatRun(1, planned+20*60_000)
	if r := p.PreheatHistory()[0]; r.ReadyByTargetAt != nil || r.PlannedSwitchOnAt != nil {
		t.Fatalf("stale pair attached: %+v", r)
	}

	p.closePreheatRun(1, planned+21*60_000)
	p.openPreheatRun(1, planned+22*60_000)
	if r := p.PreheatHistory()[0]; r.ReadyByTargetAt != nil || r.PlannedSwitchOnAt != nil {
		t.Fatalf("stale pair resurrected: %+v", r)
	}
}

// TestCheckReadyByPreheat_RemembersPairForNextRun exercises the preheat.go
// hook: firing the ready-by turn-on stores the pair the next run picks up.
func TestCheckReadyByPreheat_RemembersPairForNextRun(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	now := time.Now().UnixMilli()
	planned := now - 1000
	target := now + 5*60_000
	p.state.mu.Lock()
	p.state.readyByTargetAt = &target
	p.state.plannedSwitchOnAt = &planned
	p.state.mu.Unlock()

	p.checkReadyByPreheat(context.Background())

	p.state.mu.Lock()
	gotReady, gotPlanned := p.state.readyByTargetAt, p.state.plannedSwitchOnAt
	p.state.mu.Unlock()
	if gotReady != nil || gotPlanned != nil {
		t.Fatal("checkReadyByPreheat should clear the target after firing")
	}

	p.openPreheatRun(1, now)
	run := p.PreheatHistory()[0]
	if run.ReadyByTargetAt == nil || *run.ReadyByTargetAt != target {
		t.Fatalf("ReadyByTargetAt = %v, want %d", run.ReadyByTargetAt, target)
	}
	if run.PlannedSwitchOnAt == nil || *run.PlannedSwitchOnAt != planned {
		t.Fatalf("PlannedSwitchOnAt = %v, want %d", run.PlannedSwitchOnAt, planned)
	}
}

// TestPollViaGaggiuinoStatus_StableMarksRun exercises the poll-tick hook: a
// stable reading marks the open run without moving the run's real switch-on
// time, even though the runtime's own SwitchOnAt is backdated.
func TestPollViaGaggiuinoStatus_StableMarksRun(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 93.5, 94, 9, 18.2, false, "Espresso", 1), nil)
	p := newPreheatHistoryPoller(t, fake)

	realOn := time.Now().UnixMilli() - 5_000
	p.openPreheatRun(1, realOn)
	p.runtime.SetSwitchOnAt(&realOn)
	for i := 0; i < tempStableMin; i++ {
		p.runtime.PushTempHistory(93.5)
	}

	p.pollViaGaggiuinoStatus(context.Background())

	run := p.PreheatHistory()[0]
	if run.StableAt == nil {
		t.Fatal("StableAt not set by the stability block")
	}
	if run.SwitchOnAt != realOn {
		t.Fatalf("run SwitchOnAt = %d, want the real %d", run.SwitchOnAt, realOn)
	}
	if got := p.runtime.Get().SwitchOnAt; got == nil || *got == realOn {
		t.Fatalf("runtime SwitchOnAt = %v, want it backdated", got)
	}
}

// TestPreheatHistory_TwoMachinesKeepOwnRuns (#2247): each machine has its own
// open run, and the default machine's history never shows another machine's.
func TestPreheatHistory_TwoMachinesKeepOwnRuns(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	p.openPreheatRun(1, 1000)
	p.openPreheatRun(2, 1500)
	p.recordPreheatSample(2, 1500, 90, 93)
	p.closePreheatRun(1, 2000)

	h := p.PreheatHistory()
	if len(h) != 1 || h[0].SwitchOnAt != 1000 || h[0].SwitchOffAt == nil || h[0].MachineID != 1 {
		t.Fatalf("default history = %+v, want only machine 1's closed run", h)
	}
	p.preheatHist.mu.Lock()
	open2 := p.preheatHist.open[2]
	p.preheatHist.mu.Unlock()
	if open2 == nil || open2.SwitchOffAt != nil || len(open2.Samples) != 1 || open2.MachineID != 2 {
		t.Fatalf("machine 2's open run = %+v, want still open with its one sample", open2)
	}

	p.closePreheatRun(2, 3000)
	if h := p.PreheatHistory(); len(h) != 1 || h[0].MachineID != 1 {
		t.Errorf("default history after machine 2 closed = %+v, want only machine 1's run", h)
	}
}

// TestPreheatHistory_LegacyRunsCountAsDefault (#2247): a run stored before
// runs carried a machine id belongs to the default machine.
func TestPreheatHistory_LegacyRunsCountAsDefault(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	legacy := `[{"switchOnAt":1000,"switchOffAt":2000,"preheatMinutes":15,"predictedReadyAt":901000,"stableAt":null,"readyByTargetAt":null,"plannedSwitchOnAt":null,"samples":[]}]`
	if err := os.WriteFile(preheatHistoryFile, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy history: %v", err)
	}
	if h := p.PreheatHistory(); len(h) != 1 || h[0].SwitchOnAt != 1000 {
		t.Fatalf("history = %+v, want the legacy run", h)
	}
}

// TestPreheatHistory_RunCapIsPerMachine (#2247): a busy second machine never
// pushes the default machine's runs out of the capped history.
func TestPreheatHistory_RunCapIsPerMachine(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	p.openPreheatRun(1, 1)
	p.closePreheatRun(1, 2)
	for i := 0; i < preheatHistoryMaxRuns+5; i++ {
		at := int64(10 + i*10)
		p.openPreheatRun(2, at)
		p.closePreheatRun(2, at+5)
	}
	if h := p.PreheatHistory(); len(h) != 1 || h[0].SwitchOnAt != 1 {
		t.Fatalf("default history = %+v, want machine 1's single run kept", h)
	}
	p.preheatHist.mu.Lock()
	n := 0
	for _, r := range p.preheatHist.runs {
		if r.MachineID == 2 {
			n++
		}
	}
	p.preheatHist.mu.Unlock()
	if n != preheatHistoryMaxRuns {
		t.Errorf("machine 2 kept %d runs, want %d", n, preheatHistoryMaxRuns)
	}
}

// TestPreheatHistory_ReadyByPairPerMachine (#2247): a ready-by pair attaches
// to the next run of its own machine only.
func TestPreheatHistory_ReadyByPairPerMachine(t *testing.T) {
	p := newPreheatHistoryPoller(t, &fakeAdapter{})
	planned := time.Now().UnixMilli()
	target := planned + 15*60_000
	p.rememberLastReadyBy(2, &target, &planned)

	p.openPreheatRun(1, planned+60_000)
	if r := p.PreheatHistory()[0]; r.ReadyByTargetAt != nil {
		t.Errorf("default machine's run took machine 2's ready-by target %v", *r.ReadyByTargetAt)
	}
	p.openPreheatRun(2, planned+60_000)
	p.preheatHist.mu.Lock()
	run := p.preheatHist.open[2]
	p.preheatHist.mu.Unlock()
	if run == nil || run.ReadyByTargetAt == nil || *run.ReadyByTargetAt != target {
		t.Errorf("machine 2's run = %+v, want its ready-by target %d", run, target)
	}
}
