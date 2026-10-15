package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resetOptionsCacheForTest isolates a test's use of the package-level
// optionsCache/OptionsFile (process-wide state, shared with every other test in
// this package and with production code) and restores all of it on cleanup.
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

// TestOptions_CachesUntilFileChanges (moved here from internal/system when
// that package's own reader was folded into this one): once the TTL fast path is out
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

// TestOptions_SystemFieldsFromFile covers #1622 slice 8: preheat_time,
// expose_api_port and sync_interval -- internal/system's own options.json
// reads until this slice -- now come out of the same Options() read.
func TestOptions_SystemFieldsFromFile(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{"preheat_time":15,"expose_api_port":false,"sync_interval":30}`, time.Now())
	OptionsFile = path

	got := Options()
	if got.PreheatMinutes != 15 {
		t.Errorf("PreheatMinutes = %d, want 15", got.PreheatMinutes)
	}
	if got.APIPortExposed {
		t.Error("APIPortExposed = true, want false")
	}
	if got.SyncIntervalMinutes != 30 {
		t.Errorf("SyncIntervalMinutes = %d, want 30", got.SyncIntervalMinutes)
	}
}

// TestOptions_AbsentExposeAPIPortDefaultsOpen is the #803 regression at the
// config layer: a valid options.json that simply omits expose_api_port (an
// install predating #803) must resolve to true -- only a literal JSON `false`
// may close it.
func TestOptions_AbsentExposeAPIPortDefaultsOpen(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{}`, time.Now())
	OptionsFile = path

	if !Options().APIPortExposed {
		t.Error("absent expose_api_port: APIPortExposed = false, want true")
	}
}

// TestOptions_NonPositiveNumbersFallBackToDefaults pins internal/system's
// "positive int, else default" rule for preheat_time/sync_interval: zero,
// negative, non-integer and wrong-typed values all fall back (20/5), never the
// env var. The env vars are set to different values to prove they are ignored
// once the file itself parses.
func TestOptions_NonPositiveNumbersFallBackToDefaults(t *testing.T) {
	resetOptionsCacheForTest(t)
	t.Setenv("GLP_PREHEAT_TIME", "12")
	t.Setenv("GLP_SYNC_INTERVAL", "30")

	for _, tc := range []struct {
		name    string
		content string
	}{
		{"zero", `{"preheat_time":0,"sync_interval":0}`},
		{"negative", `{"preheat_time":-5,"sync_interval":-1}`},
		{"non-integer", `{"preheat_time":1.5,"sync_interval":2.5}`},
		{"wrong type", `{"preheat_time":true,"sync_interval":[]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "options.json")
			writeOptionsFileAt(t, path, tc.content, time.Now())
			OptionsFile = path

			got := Options()
			if got.PreheatMinutes != 20 {
				t.Errorf("PreheatMinutes = %d, want 20 (invalid preheat_time, no env fallback once the file parses)", got.PreheatMinutes)
			}
			if got.SyncIntervalMinutes != 5 {
				t.Errorf("SyncIntervalMinutes = %d, want 5 (invalid sync_interval, no env fallback once the file parses)", got.SyncIntervalMinutes)
			}
		})
	}
}

// TestOptions_BadNumericFieldDoesNotFailWholeFile is the regression guard the
// consolidation needs: internal/system parsed preheat_time and sync_interval in
// two separate structs, so a malformed preheat_time only defaulted that one
// read (to 20) while the status read still succeeded. The merged struct must
// keep that -- a bad number in one field must not turn the whole file into the
// env fallback.
func TestOptions_BadNumericFieldDoesNotFailWholeFile(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{"debug_logging":true,"enable_orders":true,"preheat_time":"nope","sync_interval":15}`, time.Now())
	OptionsFile = path

	// The file parsed, so these env vars must not be consulted.
	t.Setenv("GLP_PREHEAT_TIME", "99")
	t.Setenv("GLP_ENABLE_ORDERS", "false")

	got := Options()
	if !got.DebugLogging {
		t.Error("DebugLogging = false, want true (a bad preheat_time must not fail the whole file)")
	}
	if !got.EnableOrders {
		t.Error("EnableOrders = false, want true (a bad preheat_time must not fail the whole file)")
	}
	if got.PreheatMinutes != 20 {
		t.Errorf("PreheatMinutes = %d, want 20 (malformed preheat_time falls back to the default)", got.PreheatMinutes)
	}
	if got.SyncIntervalMinutes != 15 {
		t.Errorf("SyncIntervalMinutes = %d, want 15 (a bad preheat_time must not affect sync_interval)", got.SyncIntervalMinutes)
	}
}

// TestOptions_MissingFileSystemFieldsFallBackToEnv extends
// TestOptions_MissingFileFallsBackToEnv to #1622 slice 8's fields: a missing
// options.json resolves them from GLP_PREHEAT_TIME / GLP_EXPOSE_API_PORT /
// GLP_SYNC_INTERVAL, and to 20/true/5 when those are unset. The no-file outcome
// is latched, so this goes through expireOptionsCacheTTLForTest between
// assertions.
func TestOptions_MissingFileSystemFieldsFallBackToEnv(t *testing.T) {
	resetOptionsCacheForTest(t)
	OptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")

	t.Setenv("GLP_PREHEAT_TIME", "")
	t.Setenv("GLP_EXPOSE_API_PORT", "")
	t.Setenv("GLP_SYNC_INTERVAL", "")
	got := Options()
	if got.PreheatMinutes != 20 || !got.APIPortExposed || got.SyncIntervalMinutes != 5 {
		t.Errorf("missing options.json, no env: got %+v, want 20/true/5", got)
	}

	expireOptionsCacheTTLForTest(t)
	t.Setenv("GLP_PREHEAT_TIME", "12")
	t.Setenv("GLP_EXPOSE_API_PORT", "false")
	t.Setenv("GLP_SYNC_INTERVAL", "30")
	got = Options()
	if got.PreheatMinutes != 12 || got.APIPortExposed || got.SyncIntervalMinutes != 30 {
		t.Errorf("missing options.json, env set: got %+v, want 12/false/30", got)
	}
}

// TestOptions_UnparseableFileSystemFieldsFallBackToEnv covers the same fallback
// chain when options.json exists but isn't valid JSON.
func TestOptions_UnparseableFileSystemFieldsFallBackToEnv(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `not json`, time.Now())
	OptionsFile = path

	t.Setenv("GLP_PREHEAT_TIME", "12")
	t.Setenv("GLP_EXPOSE_API_PORT", "false")
	t.Setenv("GLP_SYNC_INTERVAL", "30")
	got := Options()
	if got.PreheatMinutes != 12 || got.APIPortExposed || got.SyncIntervalMinutes != 30 {
		t.Errorf("unparseable options.json: got %+v, want 12/false/30", got)
	}
}

// TestOptions_SystemFieldsCacheUntilFileChanges is the pre-consolidation
// internal/system TestLoadStatusOptions_CachesUntilFileChanges, moved here: past
// the TTL fast path, a cache hit (mtime unchanged) keeps serving the
// previously-parsed values even if the file's content changed underneath it
// without a new mtime, and a genuine mtime bump takes effect on the next call.
func TestOptions_SystemFieldsCacheUntilFileChanges(t *testing.T) {
	resetOptionsCacheForTest(t)
	path := filepath.Join(t.TempDir(), "options.json")
	OptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"enable_orders":true,"expose_api_port":false,"sync_interval":15}`, base)
	if got := Options(); !got.EnableOrders || got.APIPortExposed || got.SyncIntervalMinutes != 15 {
		t.Fatalf("first read: got %+v, want orders=true port=false sync=15", got)
	}

	// Rewrite the content but hold the mtime fixed -- past the TTL fast path, a
	// cache hit on mtime must keep returning the stale-but-cached values.
	expireOptionsCacheTTLForTest(t)
	writeOptionsFileAt(t, path, `{"enable_orders":false,"expose_api_port":true,"sync_interval":99}`, base)
	if got := Options(); !got.EnableOrders || got.APIPortExposed || got.SyncIntervalMinutes != 15 {
		t.Fatalf("cached (mtime unchanged): got %+v, want orders=true port=false sync=15", got)
	}

	// Now bump the mtime -- the new values must take effect on this next call.
	expireOptionsCacheTTLForTest(t)
	writeOptionsFileAt(t, path, `{"enable_orders":false,"expose_api_port":true,"sync_interval":99}`, base.Add(time.Second))
	if got := Options(); got.EnableOrders || !got.APIPortExposed || got.SyncIntervalMinutes != 99 {
		t.Fatalf("mtime bumped: got %+v, want orders=false port=true sync=99", got)
	}
}
