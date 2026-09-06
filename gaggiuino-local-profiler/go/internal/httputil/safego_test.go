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
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic escaped SafeCall: %v", r)
			}
		}()
		SafeCall("test", func() { panic("boom") })
		// Reached only if SafeCall returned normally instead of the panic
		// propagating out of it.
		completed = true
	}()
	if !completed {
		t.Fatal("SafeCall did not return normally after recovering the panic")
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
