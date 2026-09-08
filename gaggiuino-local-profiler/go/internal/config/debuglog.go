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
var debugLoggingCache struct {
	mu      sync.Mutex
	valid   bool // false until the first os.Stat succeeds
	mtime   time.Time
	enabled bool
}

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

	info, statErr := os.Stat(OptionsFile)
	if statErr == nil && debugLoggingCache.valid && info.ModTime().Equal(debugLoggingCache.mtime) {
		return debugLoggingCache.enabled
	}

	enabled := parseDebugLoggingFile()
	debugLoggingCache.valid = statErr == nil
	if statErr == nil {
		debugLoggingCache.mtime = info.ModTime()
	}
	debugLoggingCache.enabled = enabled
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
