package system

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/config"
)

// pointOptionsAt points internal/config's shared OptionsFile at path for one
// test and restores the previous value on cleanup. Every call site passes a
// fresh temp path, which sidesteps config's mtime+TTL cache without touching
// its unexported state: the cache is keyed on the path it was read from, so a
// new path always re-parses. The option-parsing semantics themselves now live
// in internal/config/options_test.go, since this package reads through it
// (#1622 slice 8).
func pointOptionsAt(t *testing.T, path string) {
	t.Helper()
	orig := config.OptionsFile
	config.OptionsFile = path
	t.Cleanup(func() { config.OptionsFile = orig })
}

// writeOptions writes content to a fresh options.json under a temp dir and
// returns its path -- fresh per call so the cache never serves a previous
// test's value.
func writeOptions(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "options.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return path
}

// TestSystemOptionsReadThroughConfig pins that the four system wrappers read
// the values config.Options() parses out of OptionsFile (#1622 slice 8).
func TestSystemOptionsReadThroughConfig(t *testing.T) {
	path := writeOptions(t, `{"preheat_time":15,"enable_orders":true,"expose_api_port":false,"sync_interval":30}`)
	pointOptionsAt(t, path)

	if got := loadPreheatMinutes(); got != 15 {
		t.Errorf("loadPreheatMinutes() = %d, want 15", got)
	}
	if !isOrdersEnabled() {
		t.Error("isOrdersEnabled() = false, want true")
	}
	if isApiPortExposed() {
		t.Error("isApiPortExposed() = true, want false")
	}
	if got := loadSyncIntervalMinutes(); got != 30 {
		t.Errorf("loadSyncIntervalMinutes() = %d, want 30", got)
	}
}

// TestIsApiPortExposed_DefaultsOpen is the #803 regression, exercised through
// the system wrapper: a missing options.json and a valid one that simply lacks
// the expose_api_port key (an install predating #803) must both resolve to
// true -- only a literal JSON `false` may close it. See #901's getToken doc
// comment for why an accidental default-closed here would repeat the v2.19.1
// regression.
func TestIsApiPortExposed_DefaultsOpen(t *testing.T) {
	t.Setenv("GLP_EXPOSE_API_PORT", "")

	pointOptionsAt(t, filepath.Join(t.TempDir(), "does-not-exist.json"))
	if !isApiPortExposed() {
		t.Error("missing options.json: isApiPortExposed() = false, want true (default open)")
	}

	pointOptionsAt(t, writeOptions(t, `{"sync_interval":5}`))
	if !isApiPortExposed() {
		t.Error("expose_api_port key absent: isApiPortExposed() = false, want true")
	}

	pointOptionsAt(t, writeOptions(t, `{"expose_api_port":false}`))
	if isApiPortExposed() {
		t.Error("expose_api_port:false: isApiPortExposed() = true, want false")
	}
}

// TestLoadPreheatMinutes_FallsBackWhenFileMissing keeps a system-level check of
// the GLP_PREHEAT_TIME/default-20 fallback chain (#764): a missing options.json
// resolves to the env var when it is a positive int, else 20. Each call uses a
// fresh path so config's TTL fast path never serves the previous call's value.
func TestLoadPreheatMinutes_FallsBackWhenFileMissing(t *testing.T) {
	pointOptionsAt(t, filepath.Join(t.TempDir(), "does-not-exist.json"))
	t.Setenv("GLP_PREHEAT_TIME", "")
	if got := loadPreheatMinutes(); got != 20 {
		t.Fatalf("loadPreheatMinutes() = %d, want 20 (default)", got)
	}

	pointOptionsAt(t, filepath.Join(t.TempDir(), "also-missing.json"))
	t.Setenv("GLP_PREHEAT_TIME", "12")
	if got := loadPreheatMinutes(); got != 12 {
		t.Fatalf("loadPreheatMinutes() = %d, want 12 (GLP_PREHEAT_TIME)", got)
	}
}

// TestLoadSyncIntervalMinutes_FallsBackWhenFileMissing is the sync_interval
// counterpart: GLP_SYNC_INTERVAL (positive int) when there is no options.json,
// else 5.
func TestLoadSyncIntervalMinutes_FallsBackWhenFileMissing(t *testing.T) {
	pointOptionsAt(t, filepath.Join(t.TempDir(), "does-not-exist.json"))
	t.Setenv("GLP_SYNC_INTERVAL", "")
	if got := loadSyncIntervalMinutes(); got != 5 {
		t.Fatalf("loadSyncIntervalMinutes() = %d, want 5 (default)", got)
	}

	pointOptionsAt(t, filepath.Join(t.TempDir(), "also-missing.json"))
	t.Setenv("GLP_SYNC_INTERVAL", "30")
	if got := loadSyncIntervalMinutes(); got != 30 {
		t.Fatalf("loadSyncIntervalMinutes() = %d, want 30 (GLP_SYNC_INTERVAL)", got)
	}
}
