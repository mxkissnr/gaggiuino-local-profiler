package system

import (
	"context"
	"testing"
	"time"
)

// readySwitchOnAt is a switch-on time far enough in the past that the default
// preheat window has already elapsed, so PreheatInfo reports ready.
func readySwitchOnAt() *int64 {
	at := time.Now().UnixMilli() - 21*60_000
	return &at
}

func TestPreheatReadyNotifier_FiresOncePerRun(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	var calls int
	p.SetPreheatReadyNotifier(func(context.Context) bool { calls++; return true })
	t.Cleanup(func() { p.SetPreheatReadyNotifier(nil) })

	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(readySwitchOnAt())

	for i := 0; i < 3; i++ {
		p.preheatWatchTick(context.Background())
	}
	if calls != 1 {
		t.Fatalf("preheat-ready notifier called %d times, want exactly 1 per run", calls)
	}
}

func TestPreheatReadyNotifier_RetriesUntilDelivered(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	var calls int
	p.SetPreheatReadyNotifier(func(context.Context) bool { calls++; return calls >= 2 })
	t.Cleanup(func() { p.SetPreheatReadyNotifier(nil) })

	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(readySwitchOnAt())

	p.preheatWatchTick(context.Background())
	if calls != 1 {
		t.Fatalf("notifier called %d times after the failed push, want 1", calls)
	}
	p.preheatWatchTick(context.Background()) // delivers
	if calls != 2 {
		t.Fatalf("notifier called %d times, want 2", calls)
	}
	p.preheatWatchTick(context.Background()) // latched
	if calls != 2 {
		t.Fatalf("notifier called %d times after delivery, want still 2", calls)
	}
}

func TestPreheatReadyNotifier_RearmsAfterNewSwitchOn(t *testing.T) {
	fake := &fakeAdapter{}
	p, _ := newTestPoller(t, fake)

	var calls int
	p.SetPreheatReadyNotifier(func(context.Context) bool { calls++; return true })
	t.Cleanup(func() { p.SetPreheatReadyNotifier(nil) })

	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(readySwitchOnAt())
	p.preheatWatchTick(context.Background())
	if calls != 1 {
		t.Fatalf("notifier called %d times, want 1", calls)
	}
	p.preheatWatchTick(context.Background())
	if calls != 1 {
		t.Fatalf("notifier called %d times after the first run, want still 1", calls)
	}

	// The run ends (no switch-on time -> not ready): the one-per-run latch is
	// cleared, so a fresh ready cycle notifies again.
	p.runtime.SetSwitchOnAt(nil)
	p.preheatWatchTick(context.Background())
	if calls != 1 {
		t.Fatalf("notifier called %d times outside a preheat run, want still 1", calls)
	}
	p.runtime.SetSwitchOnAt(readySwitchOnAt())
	p.preheatWatchTick(context.Background())
	if calls != 2 {
		t.Fatalf("notifier not re-armed for the new run: %d calls, want 2", calls)
	}
}
