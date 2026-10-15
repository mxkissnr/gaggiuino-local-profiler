package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resetOptionsCacheForTest isolates a test's use of the package-level
// optionsCache/OptionsFile (process-wide state, shared with every other test in
// this package and with production code) and restores all of it on cleanup,
// mirroring internal/system/options_test.go's resetPreheatMinutesCacheForTest
// for the identical reason.
func resetOptionsCacheForTest(t *testing.T) {
	t.Helper()
	origFile := OptionsFile
	optionsCache.mu.Lock()
	origValid := optionsCache.valid
	origPath := optionsCache.path
	origMtime := optionsCache.mtime
	origChecked := optionsCache.checked
	origValue := optionsCache.value
	optionsCache.valid = false
	optionsCache.mu.Unlock()
	t.Cleanup(func() {
		OptionsFile = origFile
		optionsCache.mu.Lock()
		optionsCache.valid = origValid
		optionsCache.path = origPath
		optionsCache.mtime = origMtime
		optionsCache.checked = origChecked
		optionsCache.value = origValue
		optionsCache.mu.Unlock()
	})
}

// expireOptionsCacheTTLForTest backdates the cache's last-checked time past
// cacheTTL, so the next Options() call falls through to the mtime check instead
// of the TTL fast path -- lets tests exercise the mtime-based invalidation
// without an actual cacheTTL-length sleep.
func expireOptionsCacheTTLForTest(t *testing.T) {
	t.Helper()
	optionsCache.mu.Lock()
	optionsCache.checked = time.Now().Add(-cacheTTL - time.Second)
	optionsCache.mu.Unlock()
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

// TestOptions_AllFieldsFromFile covers the #1622 slice-6 consolidation: every
// field the three callers used to read with their own loader now comes out of
// one Options() read.
func TestOptions_AllFieldsFromFile(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{"debug_logging":true,"allowed_hosts":"a.example,b.example","enable_orders":true}`, time.Now())
	OptionsFile = path

	got := Options()
	if !got.DebugLogging {
		t.Error("DebugLogging = false, want true")
	}
	if got.AllowedHosts != "a.example,b.example" {
		t.Errorf("AllowedHosts = %q, want %q", got.AllowedHosts, "a.example,b.example")
	}
	if !got.EnableOrders {
		t.Error("EnableOrders = false, want true")
	}
}

// TestOptions_AbsentKeysAreFalseAndEmpty pins the "present file, absent key"
// branch: a valid options.json that omits a field reads it as false/"", never
// as the env var.
func TestOptions_AbsentKeysAreFalseAndEmpty(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{}`, time.Now())
	OptionsFile = path

	// Env vars set true must NOT leak into a present, valid file.
	t.Setenv("GLP_DEBUG_LOGGING", "true")
	t.Setenv("GLP_ENABLE_ORDERS", "true")

	got := Options()
	if got.DebugLogging {
		t.Error("absent debug_logging: DebugLogging = true, want false")
	}
	if got.AllowedHosts != "" {
		t.Errorf("absent allowed_hosts: AllowedHosts = %q, want empty", got.AllowedHosts)
	}
	if got.EnableOrders {
		t.Error("absent enable_orders: EnableOrders = true, want false")
	}
}

// TestOptions_MissingFileFallsBackToEnv covers the #764 standalone-Docker
// fallback (GLP_DEBUG_LOGGING / GLP_ENABLE_ORDERS) when options.json doesn't
// exist. The no-file outcome is latched as "valid" too (like the file-exists
// case), so this goes through expireOptionsCacheTTLForTest between assertions
// -- otherwise the second env-var change would be masked by the still-live TTL
// fast path.
func TestOptions_MissingFileFallsBackToEnv(t *testing.T) {
	resetOptionsCacheForTest(t)
	OptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")

	t.Setenv("GLP_DEBUG_LOGGING", "")
	t.Setenv("GLP_ENABLE_ORDERS", "")
	got := Options()
	if got.DebugLogging || got.EnableOrders {
		t.Errorf("missing options.json, no env: got %+v, want all false", got)
	}
	if got.AllowedHosts != "" {
		t.Errorf("missing options.json: AllowedHosts = %q, want empty (no env fallback)", got.AllowedHosts)
	}

	expireOptionsCacheTTLForTest(t)
	t.Setenv("GLP_DEBUG_LOGGING", "true")
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	got = Options()
	if !got.DebugLogging || !got.EnableOrders {
		t.Errorf("missing options.json, env true: got %+v, want both true", got)
	}
}

// TestOptions_UnparseableFileFallsBackToEnv covers the same fallback chain when
// options.json exists but isn't valid JSON.
func TestOptions_UnparseableFileFallsBackToEnv(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `not json`, time.Now())
	OptionsFile = path

	t.Setenv("GLP_DEBUG_LOGGING", "true")
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	got := Options()
	if !got.DebugLogging || !got.EnableOrders {
		t.Errorf("unparseable options.json, env true: got %+v, want both true", got)
	}
}

// TestOptions_MissingFileLatchesTTLFastPath is the round-7 regression test for
// the bug this caching fixes: a permanently-absent options.json (#764
// standalone Docker) used to leave the cache's valid flag false forever, so
// every call re-ran os.Stat and os.ReadFile rather than hitting the TTL fast
// path. Proof: change the env var within cacheTTL of the first call and confirm
// it is NOT picked up.
func TestOptions_MissingFileLatchesTTLFastPath(t *testing.T) {
	resetOptionsCacheForTest(t)
	OptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")

	t.Setenv("GLP_DEBUG_LOGGING", "false")
	if Options().DebugLogging {
		t.Fatal("DebugLogging = true, want false")
	}

	optionsCache.mu.Lock()
	valid := optionsCache.valid
	optionsCache.mu.Unlock()
	if !valid {
		t.Fatal("optionsCache.valid = false after a no-file call, want true (must latch so the TTL fast path engages)")
	}

	// A genuine env-var change, but the TTL has not been expired -- must not be
	// picked up yet, proving the cache is actually short-circuiting
	// os.Stat/os.ReadFile rather than happening to return the same answer.
	t.Setenv("GLP_DEBUG_LOGGING", "true")
	if Options().DebugLogging {
		t.Fatal("DebugLogging = true, want false (within cacheTTL, must not re-check yet)")
	}

	expireOptionsCacheTTLForTest(t)
	if !Options().DebugLogging {
		t.Fatal("DebugLogging = false, want true (TTL expired, env change now picked up)")
	}
}

// TestOptions_CachesUntilFileChanges mirrors internal/system/options_test.go's
// TestLoadStatusOptions_CachesUntilFileChanges: once the TTL fast path is out
// of the way, a cache hit (mtime unchanged) must keep serving the
// previously-parsed value even if the file's *content* changed underneath it
// without a new mtime, and a genuine mtime bump must take effect on the very
// next (TTL-expired) call.
func TestOptions_CachesUntilFileChanges(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"debug_logging":true}`, base)
	if !Options().DebugLogging {
		t.Fatal("DebugLogging = false, want true")
	}

	// Rewrite the content but hold the mtime fixed -- past the TTL fast path, a
	// cache hit on mtime must keep returning the stale-but-cached true, not
	// re-parse.
	expireOptionsCacheTTLForTest(t)
	if err := os.WriteFile(path, []byte(`{"debug_logging":false}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chtimes(path, base, base); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	if !Options().DebugLogging {
		t.Fatal("DebugLogging = false, want true (cached, mtime unchanged)")
	}

	// Now bump the mtime -- once the TTL fast path is also expired, the new
	// value must take effect immediately.
	expireOptionsCacheTTLForTest(t)
	writeOptionsFileAt(t, path, `{"debug_logging":false}`, base.Add(time.Second))
	if Options().DebugLogging {
		t.Fatal("DebugLogging = true, want false (mtime changed, cache invalidated)")
	}
}

// TestOptions_TTLSuppressesMtimeCheck is the round-5 regression test for the
// cache's TTL layer: within cacheTTL of the last check, a real mtime/content
// change on disk must NOT be picked up yet, proving the fast path really skips
// the os.Stat rather than just being a no-op optimization.
func TestOptions_TTLSuppressesMtimeCheck(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"debug_logging":false}`, base)
	if Options().DebugLogging {
		t.Fatal("DebugLogging = true, want false")
	}

	// A genuine change, but the TTL has not been expired -- must not be picked
	// up yet.
	writeOptionsFileAt(t, path, `{"debug_logging":true}`, base.Add(time.Second))
	if Options().DebugLogging {
		t.Fatal("DebugLogging = true, want false (within cacheTTL, must not re-check yet)")
	}

	expireOptionsCacheTTLForTest(t)
	if !Options().DebugLogging {
		t.Fatal("DebugLogging = false, want true (TTL expired, mtime change now picked up)")
	}
}

// TestOptions_RepointingOptionsFileBustsCache covers the path key added on top
// of the mtime/TTL cache: internal/orders' handler tests repoint the shared
// OptionsFile at a fresh temp file per test, and must see that file's value
// even though cacheTTL has not expired.
func TestOptions_RepointingOptionsFileBustsCache(t *testing.T) {
	resetOptionsCacheForTest(t)

	first := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, first, `{"debug_logging":true}`, time.Now())
	OptionsFile = first
	if !Options().DebugLogging {
		t.Fatal("DebugLogging = false, want true (first file)")
	}

	second := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, second, `{"debug_logging":false}`, time.Now())
	OptionsFile = second
	if Options().DebugLogging {
		t.Fatal("DebugLogging = true, want false (repointing OptionsFile must not serve the first file's cached value)")
	}
}

// TestIsDebugLoggingEnabled_DelegatesToOptions keeps a behavioural test on the
// exported debug_logging accessor now that it is a thin wrapper over Options().
func TestIsDebugLoggingEnabled_DelegatesToOptions(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"debug_logging":true}`, base)
	if !IsDebugLoggingEnabled() {
		t.Error("debug_logging:true: IsDebugLoggingEnabled() = false, want true")
	}

	expireOptionsCacheTTLForTest(t)
	writeOptionsFileAt(t, path, `{"debug_logging":false}`, base.Add(time.Second))
	if IsDebugLoggingEnabled() {
		t.Error("debug_logging:false: IsDebugLoggingEnabled() = true, want false")
	}
}
