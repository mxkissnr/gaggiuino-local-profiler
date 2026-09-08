// Package config holds narrow, dependency-free options.json helpers that
// more than one internal package needs to share (#977 follow-up code
// review, round 4). It intentionally imports nothing from this repo, so
// any package can depend on it without creating a cycle -- see
// IsDebugLoggingEnabled's doc comment for the specific cycle this was
// extracted to break.
package config

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// OptionsFile is the Supervisor-written options.json path -- a var, not a
// const, so tests can point it at a temp file, mirroring
// internal/system's own defaultOptionsFile (constants.go).
var OptionsFile = "/data/options.json"

// debugLoggingCache caches IsDebugLoggingEnabled()'s parsed result, keyed
// on options.json's mtime -- the same pattern internal/system/options.go's
// preheatMinutesCache/statusOptionsCache use, for the same reason: this
// file is only ever rewritten by a rare Configuration-UI edit, not
// something worth a fresh os.ReadFile+json.Unmarshal on every call.
//
// checked/cacheTTL add a second layer on top of the mtime check (#977
// follow-up code review, round 5): this is the ONE shared debug_logging
// cache now -- it used to be three independent hand-rolled caches (this
// one, plus internal/system/poll.go's own debugTickLogCache wrapping it for
// the 1s poll tick, plus sync.go's per-shot bulk-sync loop paying the
// mtime check's mutex-lock+os.Stat unthrottled). A poll tick or a
// historical backfill of many shots can call IsDebugLoggingEnabled() far
// more often than options.json could plausibly change, so within cacheTTL
// of the last check this skips the os.Stat entirely and just returns the
// cached value; debug_logging is a manual Configuration-UI toggle, not
// something that needs sub-second pickup, so a short TTL costs nothing in
// practice while saving a stat call on every hot-path call.
var debugLoggingCache struct {
	mu      sync.Mutex
	valid   bool // false until the first os.Stat succeeds
	mtime   time.Time
	checked time.Time
	enabled bool
}

// cacheTTL is how long IsDebugLoggingEnabled() trusts its cached value
// without even checking options.json's mtime -- sized for a 1-second poll
// caller (internal/system/poll.go's pollViaGaggiuinoStatus), the tightest
// hot path that calls this.
const cacheTTL = 5 * time.Second

// IsDebugLoggingEnabled ports lib/data.js's isDebugLoggingEnabled() /
// loadOptions().debug_logging (#977 follow-up): off by default, falling
// back to GLP_DEBUG_LOGGING (#764, standalone Docker) when options.json is
// missing or doesn't parse.
//
// Lives in this standalone leaf package rather than internal/system,
// because internal/machines needs this exact check too
// (registry.go's Registry.LogRegistrySnapshot) and internal/system already
// imports internal/machines -- importing internal/system back from
// internal/machines would be a cycle. Both packages import this one
// instead of each maintaining an independent copy of the same read+parse+
// mtime-cache logic (previously true for internal/machines/registry.go,
// which had its own line-for-line duplicate before this extraction).
func IsDebugLoggingEnabled() bool {
	debugLoggingCache.mu.Lock()
	defer debugLoggingCache.mu.Unlock()

	if debugLoggingCache.valid && time.Since(debugLoggingCache.checked) < cacheTTL {
		return debugLoggingCache.enabled
	}

	info, statErr := os.Stat(OptionsFile)
	if statErr == nil && debugLoggingCache.valid && info.ModTime().Equal(debugLoggingCache.mtime) {
		debugLoggingCache.checked = time.Now()
		return debugLoggingCache.enabled
	}

	enabled := parseDebugLoggingFile()
	debugLoggingCache.valid = statErr == nil
	if statErr == nil {
		debugLoggingCache.mtime = info.ModTime()
	}
	debugLoggingCache.enabled = enabled
	debugLoggingCache.checked = time.Now()
	return enabled
}

// parseDebugLoggingFile does IsDebugLoggingEnabled()'s actual read+parse+
// fallback chain -- split out so IsDebugLoggingEnabled itself only holds
// the cache-check/cache-store logic, matching internal/system/options.go's
// own parsePreheatMinutesFile/parseStatusOptionsFile split.
func parseDebugLoggingFile() bool {
	data, err := os.ReadFile(OptionsFile)
	if err != nil {
		return os.Getenv("GLP_DEBUG_LOGGING") == "true"
	}
	var opts struct {
		DebugLogging bool `json:"debug_logging"`
	}
	if err := json.Unmarshal(data, &opts); err != nil {
		return os.Getenv("GLP_DEBUG_LOGGING") == "true"
	}
	return opts.DebugLogging
}
