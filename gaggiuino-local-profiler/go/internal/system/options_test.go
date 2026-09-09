package system

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resetPreheatMinutesCacheForTest isolates a test's use of the
// package-level preheatMinutesCache/statusOptionsCache/defaultOptionsFile
// (all process-wide state, shared with every other test in this package and
// with production code) and restores all of it on cleanup.
func resetPreheatMinutesCacheForTest(t *testing.T) {
	t.Helper()
	origFile := defaultOptionsFile
	preheatMinutesCache.mu.Lock()
	origValid, origMtime, origMinutes := preheatMinutesCache.valid, preheatMinutesCache.mtime, preheatMinutesCache.minutes
	preheatMinutesCache.valid = false
	preheatMinutesCache.mu.Unlock()
	statusOptionsCache.mu.Lock()
	origStatusValid, origStatusMtime, origStatusOpts := statusOptionsCache.valid, statusOptionsCache.mtime, statusOptionsCache.opts
	statusOptionsCache.valid = false
	statusOptionsCache.mu.Unlock()
	t.Cleanup(func() {
		defaultOptionsFile = origFile
		preheatMinutesCache.mu.Lock()
		preheatMinutesCache.valid = origValid
		preheatMinutesCache.mtime = origMtime
		preheatMinutesCache.minutes = origMinutes
		preheatMinutesCache.mu.Unlock()
		statusOptionsCache.mu.Lock()
		statusOptionsCache.valid = origStatusValid
		statusOptionsCache.mtime = origStatusMtime
		statusOptionsCache.opts = origStatusOpts
		statusOptionsCache.mu.Unlock()
	})
}

// TestLoadPreheatMinutes_CachesUntilFileChanges is the #901 code-review
// regression test for loadPreheatMinutes()'s caching: a cache hit (mtime
// unchanged) must keep serving the previously-parsed value even if the
// file's *content* changed underneath it without a new mtime, proving this
// isn't silently re-reading on every call — and a genuine mtime bump must
// still take effect on the very next call, proving the cache isn't stale
// forever either.
func TestLoadPreheatMinutes_CachesUntilFileChanges(t *testing.T) {
	resetPreheatMinutesCacheForTest(t)

	path := filepath.Join(t.TempDir(), "options.json")
	defaultOptionsFile = path

	writeOptionsAt := func(minutes int, at time.Time) {
		t.Helper()
		if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"preheat_time":%d}`, minutes)), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatalf("Chtimes: %v", err)
		}
	}

	base := time.Now().Truncate(time.Second)
	writeOptionsAt(15, base)
	if got := loadPreheatMinutes(); got != 15 {
		t.Fatalf("loadPreheatMinutes() = %d, want 15", got)
	}

	// Rewrite the content but hold the mtime fixed -- a cache hit must
	// keep returning the stale-but-cached 15, not re-parse.
	if err := os.WriteFile(path, []byte(`{"preheat_time":99}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chtimes(path, base, base); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	if got := loadPreheatMinutes(); got != 15 {
		t.Fatalf("loadPreheatMinutes() = %d, want 15 (cached, mtime unchanged)", got)
	}

	// Now bump the mtime -- the new value must take effect on this very
	// next call, not lag behind.
	writeOptionsAt(25, base.Add(time.Second))
	if got := loadPreheatMinutes(); got != 25 {
		t.Fatalf("loadPreheatMinutes() = %d, want 25 (mtime changed, cache invalidated)", got)
	}
}

// TestLoadPreheatMinutes_FallsBackWhenFileMissing ports the pre-existing
// no-file/env-var/default-20 fallback chain, now routed through the cache
// path too (a missing file never becomes "valid", so every call re-checks
// rather than latching onto a stale fallback forever).
func TestLoadPreheatMinutes_FallsBackWhenFileMissing(t *testing.T) {
	resetPreheatMinutesCacheForTest(t)
	defaultOptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")

	t.Setenv("GLP_PREHEAT_TIME", "")
	if got := loadPreheatMinutes(); got != 20 {
		t.Fatalf("loadPreheatMinutes() = %d, want 20 (default)", got)
	}

	t.Setenv("GLP_PREHEAT_TIME", "12")
	if got := loadPreheatMinutes(); got != 12 {
		t.Fatalf("loadPreheatMinutes() = %d, want 12 (GLP_PREHEAT_TIME)", got)
	}
}

// TestIsApiPortExposed_DefaultsOpen is the #803 regression: a missing
// options.json, one that doesn't parse, and a valid one that simply lacks
// the expose_api_port key (an install predating #803) must all resolve to
// true — only a literal JSON `false` may close it. See #901's getToken doc
// comment for why an accidental default-closed here would repeat the
// v2.19.1 regression.
// writeOptionsFileAt writes content to path and pins its mtime to at, so a
// same-path rewrite is guaranteed to bump statusOptionsCache's mtime key
// (two os.WriteFile calls close together can otherwise land on the same
// filesystem-timestamp granularity and look like a no-op to the cache).
func writeOptionsFileAt(t *testing.T, path, content string, at time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
}

func TestIsApiPortExposed_DefaultsOpen(t *testing.T) {
	resetPreheatMinutesCacheForTest(t)

	defaultOptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")
	t.Setenv("GLP_EXPOSE_API_PORT", "")
	if !isApiPortExposed() {
		t.Error("missing options.json: isApiPortExposed() = false, want true (default open)")
	}

	base := time.Now().Truncate(time.Second)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{"sync_interval":5}`, base)
	defaultOptionsFile = path
	if !isApiPortExposed() {
		t.Error("expose_api_port key absent: isApiPortExposed() = false, want true")
	}

	writeOptionsFileAt(t, path, `{"expose_api_port":false}`, base.Add(time.Second))
	if isApiPortExposed() {
		t.Error("expose_api_port:false: isApiPortExposed() = true, want false")
	}

	t.Setenv("GLP_EXPOSE_API_PORT", "false")
	defaultOptionsFile = filepath.Join(t.TempDir(), "still-does-not-exist.json")
	if isApiPortExposed() {
		t.Error("GLP_EXPOSE_API_PORT=false with no options.json: isApiPortExposed() = true, want false")
	}
}

func TestLoadSyncIntervalMinutes(t *testing.T) {
	resetPreheatMinutesCacheForTest(t)

	defaultOptionsFile = filepath.Join(t.TempDir(), "does-not-exist.json")
	t.Setenv("GLP_SYNC_INTERVAL", "")
	if got := loadSyncIntervalMinutes(); got != 5 {
		t.Fatalf("missing file: loadSyncIntervalMinutes() = %d, want 5", got)
	}

	base := time.Now().Truncate(time.Second)
	path := filepath.Join(t.TempDir(), "options.json")
	writeOptionsFileAt(t, path, `{"sync_interval":15}`, base)
	defaultOptionsFile = path
	if got := loadSyncIntervalMinutes(); got != 15 {
		t.Fatalf("loadSyncIntervalMinutes() = %d, want 15", got)
	}

	writeOptionsFileAt(t, path, `{}`, base.Add(time.Second))
	if got := loadSyncIntervalMinutes(); got != 5 {
		t.Fatalf("sync_interval key absent: loadSyncIntervalMinutes() = %d, want 5 (no env fallback once the file itself parses)", got)
	}
}

// TestLoadStatusOptions_CachesUntilFileChanges is the #901 code-review
// regression test for loadStatusOptions()'s caching, mirroring
// TestLoadPreheatMinutes_CachesUntilFileChanges above: a cache hit (mtime
// unchanged) must keep serving the previously-parsed values even if the
// file's *content* changed underneath it without a new mtime, and a genuine
// mtime bump must take effect on the very next call.
func TestLoadStatusOptions_CachesUntilFileChanges(t *testing.T) {
	resetPreheatMinutesCacheForTest(t)

	path := filepath.Join(t.TempDir(), "options.json")
	defaultOptionsFile = path

	base := time.Now().Truncate(time.Second)
	writeOptionsFileAt(t, path, `{"enable_orders":true,"expose_api_port":false,"sync_interval":15}`, base)
	if got := isOrdersEnabled(); !got {
		t.Fatalf("isOrdersEnabled() = %v, want true", got)
	}
	if got := isApiPortExposed(); got {
		t.Fatalf("isApiPortExposed() = %v, want false", got)
	}
	if got := loadSyncIntervalMinutes(); got != 15 {
		t.Fatalf("loadSyncIntervalMinutes() = %d, want 15", got)
	}

	// Rewrite the content but hold the mtime fixed -- cache hits must keep
	// returning the stale-but-cached values, not re-parse.
	if err := os.WriteFile(path, []byte(`{"enable_orders":false,"expose_api_port":true,"sync_interval":99}`), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Chtimes(path, base, base); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	if got := isOrdersEnabled(); !got {
		t.Fatalf("isOrdersEnabled() = %v, want true (cached, mtime unchanged)", got)
	}
	if got := isApiPortExposed(); got {
		t.Fatalf("isApiPortExposed() = %v, want false (cached, mtime unchanged)", got)
	}
	if got := loadSyncIntervalMinutes(); got != 15 {
		t.Fatalf("loadSyncIntervalMinutes() = %d, want 15 (cached, mtime unchanged)", got)
	}

	// Now bump the mtime -- the new values must take effect immediately.
	writeOptionsFileAt(t, path, `{"enable_orders":false,"expose_api_port":true,"sync_interval":99}`, base.Add(time.Second))
	if got := isOrdersEnabled(); got {
		t.Fatalf("isOrdersEnabled() = %v, want false (mtime changed, cache invalidated)", got)
	}
	if got := isApiPortExposed(); !got {
		t.Fatalf("isApiPortExposed() = %v, want true (mtime changed, cache invalidated)", got)
	}
	if got := loadSyncIntervalMinutes(); got != 99 {
		t.Fatalf("loadSyncIntervalMinutes() = %d, want 99 (mtime changed, cache invalidated)", got)
	}
}
