package httputil

import (
	"sync"
	"testing"
	"time"
)

// TestSafeCall_RecoversPanic is #993's regression test: a panic inside the
// wrapped function must be recovered and must not propagate out of
// SafeCall, which is what would otherwise crash the whole test process
// (there being nothing else upstream to catch it).
func TestSafeCall_RecoversPanic(t *testing.T) {
	completed := false
	var recovered bool
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic escaped SafeCall: %v", r)
			}
		}()
		recovered = SafeCall("test", func() { panic("boom") })
		// Reached only if SafeCall returned normally instead of the panic
		// propagating out of it.
		completed = true
	}()
	if !completed {
		t.Fatal("SafeCall did not return normally after recovering the panic")
	}
	// #994 review: the first cut of SafeCall only logged a recovered panic,
	// giving the caller no way to distinguish it from fn() completing
	// cleanly -- callers need this to convert a recovered panic into their
	// own error condition instead of proceeding on fn's zero-value output.
	if !recovered {
		t.Fatal("SafeCall returned recovered=false for a function that panicked")
	}
}

// TestSafeCall_ReportsNoPanic is TestSafeCall_RecoversPanic's counterpart:
// a clean call must report recovered=false, so callers don't mistake an
// ordinary successful result for a suppressed panic.
func TestSafeCall_ReportsNoPanic(t *testing.T) {
	ran := false
	recovered := SafeCall("test", func() { ran = true })
	if !ran {
		t.Fatal("fn was never called")
	}
	if recovered {
		t.Fatal("SafeCall returned recovered=true for a function that did not panic")
	}
}

// TestSafeGo_RecoversPanicInGoroutine proves the same guarantee holds for
// SafeGo's spawned goroutine: an unrecovered panic there would otherwise
// crash the entire process (recover() never crosses a goroutine boundary,
// so nothing outside SafeGo itself could catch it). If the panic escaped,
// this test process would exit non-zero instead of the wait below ever
// completing.
func TestSafeGo_RecoversPanicInGoroutine(t *testing.T) {
	var wg sync.WaitGroup
	wg.Add(1)
	SafeGo("test", func() {
		defer wg.Done()
		panic("boom")
	})

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SafeGo's goroutine never completed -- panic likely escaped recovery")
	}
}
