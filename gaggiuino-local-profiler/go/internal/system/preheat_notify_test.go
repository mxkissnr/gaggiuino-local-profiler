package system

import (
	"context"
	"testing"
	"time"
)

// readySwitchOnAt is a switch-on time far enough in the past that the default
// preheat window has already elapsed, so PreheatInfo reports ready. Every call
// returns a distinct value: a preheat run is identified by its switch-on, so a
// test simulating a new run must get a new timestamp even within one
// millisecond. The base is fixed once: subtracting a counter from a fresh
// time.Now() collides whenever the clock advances by exactly one step too.
var (
	readySwitchOnBase = time.Now().UnixMilli() - 21*60_000
	readySwitchOnSeq  int64
)

func readySwitchOnAt() *int64 {
	readySwitchOnSeq++
	at := readySwitchOnBase - readySwitchOnSeq
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

// TestPreheatReadyNotifier_StandbyWakeDoesNotRenotify pins the #1677 review
// fix: the latch remembers the switch-on the push was sent for, so a standby
// tick (PreheatInfo not ready) with the same switch-on does not re-arm it and
// the wake-up is not announced twice.
func TestPreheatReadyNotifier_StandbyWakeDoesNotRenotify(t *testing.T) {
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

	// Standby keeps the same switch-on: not ready, but the run stays remembered.
	p.runtime.SetStandby(true)
	p.preheatWatchTick(context.Background())
	if calls != 1 {
		t.Fatalf("notifier called %d times in standby, want still 1", calls)
	}
	p.runtime.SetStandby(false)
	p.preheatWatchTick(context.Background())
	if calls != 1 {
		t.Fatalf("notifier called %d times after the standby wake-up, want still 1", calls)
	}

	// A fresh switch-on is a new run and notifies again.
	p.runtime.SetSwitchOnAt(readySwitchOnAt())
	p.preheatWatchTick(context.Background())
	if calls != 2 {
		t.Fatalf("notifier not re-armed for a new switch-on: %d calls, want 2", calls)
	}
}
