package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resetDebugLoggingCacheForTest isolates a test's use of the package-level
// debugLoggingCache/OptionsFile (process-wide state, shared with every
// other test in this package and with production code) and restores all of
// it on cleanup, mirroring internal/system/options_test.go's
// resetPreheatMinutesCacheForTest for the identical reason.
func resetDebugLoggingCacheForTest(t *testing.T) {
	t.Helper()
	origFile := OptionsFile
	debugLoggingCache.mu.Lock()
	origValid := debugLoggingCache.valid
	origMtime := debugLoggingCache.mtime
	origChecked := debugLoggingCache.checked
	origEnabled := debugLoggingCache.enabled
	debugLoggingCache.valid = false
	debugLoggingCache.mu.Unlock()
	t.Cleanup(func() {
		OptionsFile = origFile
		debugLoggingCache.mu.Lock()
		debugLoggingCache.valid = origValid
		debugLoggingCache.mtime = origMtime
		debugLoggingCache.checked = origChecked
		debugLoggingCache.enabled = origEnabled
		debugLoggingCache.mu.Unlock()
	})
}

// expireCacheTTLForTest backdates the cache's last-checked time past
// cacheTTL, so the next IsDebugLoggingEnabled() call falls through to the
// mtime check instead of the TTL fast path -- lets tests exercise the
// mtime-based invalidation without an actual cacheTTL-length sleep.
func expireCacheTTLForTest(t *testing.T) {
	t.Helper()
	debugLoggingCache.mu.Lock()
	debugLoggingCache.checked = time.Now().Add(-cacheTTL - time.Second)
	debugLoggingCache.mu.Unlock()
}

func writeOptionsFileAt(t *testing.T, path, content string, at time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
}

// TestIsDebugLoggingEnabled_OnOff is the #977 follow-up (round 5)
// regression test for the debug_logging on/off read itself -- nothing in
// the repo exercised config.IsDebugLoggingEnabled() before this, since
// config.OptionsFile is a separate var from internal/system's
// defaultOptionsFile that no existing test overrode.
func TestIsDebugLoggingEnabled_OnOff(t *testing.T) {
	resetDebugLoggingCacheForTest(t)

	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"debug_logging":true}`, base)
	if !IsDebugLoggingEnabled() {
		t.Error("debug_logging:true: IsDebugLoggingEnabled() = false, want true")
	}

	expireCacheTTLForTest(t)
	writeOptionsFileAt(t, path, `{"debug_logging":false}`, base.Add(time.Second))
	if IsDebugLoggingEnabled() {
		t.Error("debug_logging:false: IsDebugLoggingEnabled() = true, want false")
	}
}

// TestIsDebugLoggingEnabled_MissingFileFallsBackToEnv covers the #764
// standalone-Docker fallback (GLP_DEBUG_LOGGING) when options.json doesn't
// exist -- a missing file never becomes "valid" (statErr != nil), so every
// call re-checks the env var rather than latching onto a stale value.
func TestIsDebugLoggingEnabled_MissingFileFallsBackToEnv(t *testing.T) {
	resetDebugLoggingCacheForTest(t)
	OptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")

	t.Setenv("GLP_DEBUG_LOGGING", "")
	if IsDebugLoggingEnabled() {
		t.Error("missing options.json, no env: IsDebugLoggingEnabled() = true, want false")
	}

	t.Setenv("GLP_DEBUG_LOGGING", "true")
	if !IsDebugLoggingEnabled() {
		t.Error("missing options.json, GLP_DEBUG_LOGGING=true: IsDebugLoggingEnabled() = false, want true")
	}
}

// TestIsDebugLoggingEnabled_UnparseableFileFallsBackToEnv covers the same
// fallback chain when options.json exists but isn't valid JSON.
func TestIsDebugLoggingEnabled_UnparseableFileFallsBackToEnv(t *testing.T) {
	resetDebugLoggingCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `not json`, time.Now())
	OptionsFile = path

	t.Setenv("GLP_DEBUG_LOGGING", "true")
	if !IsDebugLoggingEnabled() {
		t.Error("unparseable options.json, GLP_DEBUG_LOGGING=true: IsDebugLoggingEnabled() = false, want true")
	}
}

// TestIsDebugLoggingEnabled_CachesUntilFileChanges mirrors
// internal/system/options_test.go's TestLoadStatusOptions_CachesUntilFileChanges:
// once the TTL fast path is out of the way, a cache hit (mtime unchanged)
// must keep serving the previously-parsed value even if the file's
// *content* changed underneath it without a new mtime, and a genuine mtime
// bump must take effect on the very next (TTL-expired) call.
func TestIsDebugLoggingEnabled_CachesUntilFileChanges(t *testing.T) {
	resetDebugLoggingCacheForTest(t)

	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"debug_logging":true}`, base)
	if !IsDebugLoggingEnabled() {
		t.Fatal("IsDebugLoggingEnabled() = false, want true")
	}

	// Rewrite the content but hold the mtime fixed -- past the TTL fast
	// path, a cache hit on mtime must keep returning the stale-but-cached
	// true, not re-parse.
	expireCacheTTLForTest(t)
	if err := os.WriteFile(path, []byte(`{"debug_logging":false}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chtimes(path, base, base); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	if !IsDebugLoggingEnabled() {
		t.Fatal("IsDebugLoggingEnabled() = false, want true (cached, mtime unchanged)")
	}

	// Now bump the mtime -- once the TTL fast path is also expired, the
	// new value must take effect immediately.
	expireCacheTTLForTest(t)
	writeOptionsFileAt(t, path, `{"debug_logging":false}`, base.Add(time.Second))
	if IsDebugLoggingEnabled() {
		t.Fatal("IsDebugLoggingEnabled() = true, want false (mtime changed, cache invalidated)")
	}
}

// TestIsDebugLoggingEnabled_TTLSuppressesMtimeCheck is the round-5
// regression test for the cache's new TTL layer (the one that replaced
// internal/system/poll.go's debugTickLogCache and sync.go's unthrottled
// per-shot check): within cacheTTL of the last check, a real mtime/content
// change on disk must NOT be picked up yet, proving the fast path really
// skips the os.Stat rather than just being a no-op optimization.
func TestIsDebugLoggingEnabled_TTLSuppressesMtimeCheck(t *testing.T) {
	resetDebugLoggingCacheForTest(t)

	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"debug_logging":false}`, base)
	if IsDebugLoggingEnabled() {
		t.Fatal("IsDebugLoggingEnabled() = true, want false")
	}

	// A genuine change, but the TTL has not been expired -- must not be
	// picked up yet.
	writeOptionsFileAt(t, path, `{"debug_logging":true}`, base.Add(time.Second))
	if IsDebugLoggingEnabled() {
		t.Fatal("IsDebugLoggingEnabled() = true, want false (within cacheTTL, must not re-check yet)")
	}

	expireCacheTTLForTest(t)
	if !IsDebugLoggingEnabled() {
		t.Fatal("IsDebugLoggingEnabled() = false, want true (TTL expired, mtime change now picked up)")
	}
}
