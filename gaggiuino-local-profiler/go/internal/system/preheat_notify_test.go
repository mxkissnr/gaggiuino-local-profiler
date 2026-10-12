package system

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
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
	var switchState atomic.Value
	switchState.Store("on")
	haClient := fakeHA(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/states/switch.machine" {
			_ = json.NewEncoder(w).Encode(map[string]string{"state": switchState.Load().(string)})
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	fake := &fakeAdapter{}
	p := newTestPollerWithHA(t, fake, newTestDB(t), haClient, "switch.machine")

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

	// Switching the machine off clears the one-per-run latch (see
	// checkAndApplyMachinePower); a fresh ready cycle then notifies again.
	switchState.Store("off")
	if err := p.checkAndApplyMachinePower(context.Background()); err != nil {
		t.Fatalf("checkAndApplyMachinePower: %v", err)
	}
	p.runtime.SetMachineOn(true)
	p.runtime.SetSwitchOnAt(readySwitchOnAt())
	p.preheatWatchTick(context.Background())
	if calls != 2 {
		t.Fatalf("notifier not re-armed after a new switch-on: %d calls, want 2", calls)
	}
}
