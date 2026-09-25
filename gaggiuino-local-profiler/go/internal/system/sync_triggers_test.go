package system

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// syncCounter is a syncFn seam that records how many times an auto-trigger
// invoked a sync, and can be told to fail the first n calls.
type syncCounter struct {
	mu        sync.Mutex
	calls     int
	failUntil int
}

func (c *syncCounter) fn(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.calls <= c.failUntil {
		return errors.New("sync failed")
	}
	return nil
}

func (c *syncCounter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}

func withShortDelays(t *testing.T) {
	t.Helper()
	origBrew, origRetry, origPowerOn := syncAfterBrewDelay, syncRetryDelays, syncAfterPowerOnDelay
	syncAfterBrewDelay = 15 * time.Millisecond
	syncRetryDelays = []time.Duration{10 * time.Millisecond, 10 * time.Millisecond, 10 * time.Millisecond}
	syncAfterPowerOnDelay = 15 * time.Millisecond
	t.Cleanup(func() { syncAfterBrewDelay, syncRetryDelays, syncAfterPowerOnDelay = origBrew, origRetry, origPowerOn })
}

func TestScheduleSyncAfterBrew_FiresAfterDelay(t *testing.T) {
	withShortDelays(t)
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	var c syncCounter
	p.syncFn = c.fn

	p.scheduleSyncAfterBrew()

	// Not fired before the delay elapses.
	time.Sleep(5 * time.Millisecond)
	if c.count() != 0 {
		t.Fatalf("sync fired before the post-brew delay: %d calls", c.count())
	}
	waitFor(t, time.Second, func() bool { return c.count() == 1 })
}

func TestBrewFinished_TriggersPostBrewSync(t *testing.T) {
	withShortDelays(t)
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	var c syncCounter
	p.syncFn = c.fn

	// Brewing tick, then a not-brewing tick — the brew-finished transition.
	fake.setStatus(okStatus(t, `{}`, 93, 94, 9, 5, true, "Test Profile", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())
	fake.setStatus(okStatus(t, `{}`, 93, 94, 0, 9, false, "Test Profile", 1), nil)
	p.pollViaGaggiuinoStatus(context.Background())

	waitFor(t, time.Second, func() bool { return c.count() == 1 })

	// A steady not-brewing tick must NOT trigger another sync.
	time.Sleep(30 * time.Millisecond)
	p.pollViaGaggiuinoStatus(context.Background())
	time.Sleep(30 * time.Millisecond)
	if c.count() != 1 {
		t.Fatalf("post-brew sync fired %d times, want exactly 1", c.count())
	}
}

func TestRunScheduledSync_PeriodicWithRetryBackoff(t *testing.T) {
	withShortDelays(t)
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	p.syncIntervalOverride = 15 * time.Millisecond
	var c syncCounter
	c.failUntil = 2 // first two scheduled runs fail, then succeed
	p.syncFn = c.fn

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { p.runScheduledSync(ctx); close(done) }()

	// Regular tick fails -> retry 1 (10ms) fails -> retry 2 (10ms) succeeds
	// -> back to the regular cadence, which keeps ticking.
	waitFor(t, 2*time.Second, func() bool { return c.count() >= 4 })
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runScheduledSync did not exit after context cancel")
	}
}

func TestRunScheduledSync_NoopWithoutShotsRepo(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)
	var ran atomic.Bool
	p.syncFn = func(context.Context) error { ran.Store(true); return nil }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { p.runScheduledSync(ctx); close(done) }()
	select {
	case <-done: // returns immediately: p.shots is nil
	case <-time.After(time.Second):
		t.Fatal("runScheduledSync should return immediately without a shots repo")
	}
	if ran.Load() {
		t.Fatal("sync ran despite no shots repo wired")
	}
}

func TestSyncDefaultMachineShots_GaggiMateProbesInsteadOfHammering(t *testing.T) {
	fake := &fakeAdapter{}
	fake.setStatus(okStatus(t, `{}`, 92, 93, 0, 0, false, "Espresso", 1), nil)
	p, sqlDB := newTestPoller(t, fake)
	p.SetShotsRepo(shots.NewRepository(sqlDB))

	gm := "gaggimate"
	if _, err := machines.NewRegistry(sqlDB).UpdateMachine(1, machines.MachineInput{Type: &gm}, nil); err != nil {
		t.Fatalf("set machine type: %v", err)
	}

	if err := p.syncDefaultMachineShots(context.Background()); err != nil {
		t.Fatalf("syncDefaultMachineShots: %v", err)
	}

	// Reachability recorded from the adapter probe, but nothing was synced.
	if r := p.StatusInfo().MachineReachable; r == nil || !*r {
		t.Errorf("MachineReachable = %v, want true after a successful GaggiMate probe", r)
	}
	if ss := p.SyncState(); ss.LastSync != nil {
		t.Errorf("LastSync = %v, want nil (a probe is not a sync)", *ss.LastSync)
	}
}

func TestMaybeCatchUpAfterRecovery(t *testing.T) {
	trueV, falseV := true, false
	ts := "2026-09-02T00:00:00.000Z"
	errMsg := "boom"

	cases := []struct {
		name          string
		prevReachable *bool
		lastSyncError *string
		lastSyncTime  *string
		wantSync      bool
	}{
		{"recovery with an outstanding error", &falseV, &errMsg, &ts, true},
		{"recovery, never synced", &falseV, nil, nil, true},
		{"recovery but last sync succeeded", &falseV, nil, &ts, false},
		{"was already reachable", &trueV, &errMsg, nil, false},
		{"first poll ever (nil)", nil, &errMsg, nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeAdapter{}
			p, sqlDB := newTestPoller(t, fake)
			p.SetShotsRepo(shots.NewRepository(sqlDB))
			var c syncCounter
			p.syncFn = c.fn

			p.state.mu.Lock()
			p.state.lastSyncError = tc.lastSyncError
			p.state.lastSyncTime = tc.lastSyncTime
			p.state.mu.Unlock()

			p.maybeCatchUpAfterRecovery(tc.prevReachable)

			if tc.wantSync {
				waitFor(t, time.Second, func() bool { return c.count() == 1 })
			} else {
				time.Sleep(40 * time.Millisecond)
				if c.count() != 0 {
					t.Fatalf("catch-up sync fired (%d calls) when it should not have", c.count())
				}
			}
		})
	}
}

// TestRunScheduledSync_SyncsImmediatelyOnStart is the #1153 regression test:
// the scheduler must run one sync pass right away instead of waiting a full
// interval for the first one.
func TestRunScheduledSync_SyncsImmediatelyOnStart(t *testing.T) {
	fake := &fakeAdapter{}
	p, sqlDB := newTestPoller(t, fake)
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	p.syncIntervalOverride = time.Hour // only the immediate pass can fire within this test
	var c syncCounter
	p.syncFn = c.fn

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { p.runScheduledSync(ctx); close(done) }()

	waitFor(t, time.Second, func() bool { return c.count() == 1 })
	// The next pull is a full interval away, so nothing else may fire.
	time.Sleep(50 * time.Millisecond)
	if c.count() != 1 {
		t.Fatalf("scheduled sync fired %d times, want exactly 1 (the immediate start pass)", c.count())
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runScheduledSync did not exit after context cancel")
	}
}

// TestCheckAndApplyMachinePower_SyncsAfterPowerOn is the #1153 regression
// test: the off->on transition schedules exactly one default-machine sync
// after the power-on delay, while on->on and on->off schedule none.
func TestCheckAndApplyMachinePower_SyncsAfterPowerOn(t *testing.T) {
	withShortDelays(t)
	syncAfterPowerOnDelay = 100 * time.Millisecond // long enough to assert "not before"

	var switchState atomic.Value
	switchState.Store("off")
	haClient := fakeHA(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/states/switch.machine" {
			_ = json.NewEncoder(w).Encode(map[string]string{"state": switchState.Load().(string)})
			return
		}
		t.Errorf("unexpected HA call: %s %s", r.Method, r.URL.Path)
	})
	fake := &fakeAdapter{}
	sqlDB := newTestDB(t)
	p := newTestPollerWithHA(t, fake, sqlDB, haClient, "switch.machine")
	p.SetShotsRepo(shots.NewRepository(sqlDB))
	var c syncCounter
	p.syncFn = c.fn

	// off -> on: exactly one sync, and only after the delay.
	switchState.Store("on")
	if err := p.checkAndApplyMachinePower(context.Background()); err != nil {
		t.Fatalf("checkAndApplyMachinePower (off->on): %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if c.count() != 0 {
		t.Fatalf("sync fired before the power-on delay: %d calls", c.count())
	}
	waitFor(t, time.Second, func() bool { return c.count() == 1 })

	// on -> on: no further sync.
	if err := p.checkAndApplyMachinePower(context.Background()); err != nil {
		t.Fatalf("checkAndApplyMachinePower (on->on): %v", err)
	}

	// on -> off: no sync either.
	switchState.Store("off")
	if err := p.checkAndApplyMachinePower(context.Background()); err != nil {
		t.Fatalf("checkAndApplyMachinePower (on->off): %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if c.count() != 1 {
		t.Fatalf("sync fired %d times, want exactly 1 (only the off->on transition)", c.count())
	}
}
