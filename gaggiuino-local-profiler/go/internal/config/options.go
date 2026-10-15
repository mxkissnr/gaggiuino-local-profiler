// Package config holds narrow options.json helpers that more than one internal
// package needs to share (#977 follow-up code review, round 4). It depends on
// nothing but the standard library and internal/datadir (itself standard
// library only), so any package can depend on it without creating a cycle --
// see Options's doc comment for the specific cycle this was extracted to break.
package config

import (
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/datadir"
)

// OptionsFile is the Supervisor-written options.json path, under datadir.Root
// (the real data directory in production, a per-test directory under
// `go test`) -- a var, not a const, so tests can point it at a temp file,
// mirroring internal/system's own defaultOptionsFile (constants.go).
var OptionsFile = datadir.Path("options.json")

// options is the slice of options.json's fields more than one internal package
// reads through this one shared reader (#1622 slice 6). The type is
// deliberately unexported -- callers only ever do config.Options().DebugLogging
// and friends, reading the exported fields off the returned value, so the type
// itself never needs a name outside this package.
type options struct {
	DebugLogging bool
	AllowedHosts string
	EnableOrders bool
}

// optionsCache caches Options()'s parsed result, keyed on options.json's
// mtime -- the same pattern internal/system/options.go's
// preheatMinutesCache/statusOptionsCache use, for the same reason: this file
// is only ever rewritten by a rare Configuration-UI edit, not something worth
// a fresh os.ReadFile+json.Unmarshal on every call.
//
// checked/cacheTTL add a second layer on top of the mtime check (#977
// follow-up code review, round 5): this is the ONE shared options cache now --
// it used to be several independent hand-rolled readers (the debug_logging
// mtime+TTL cache this replaced, plus uncached reads in cmd/server for
// allowed_hosts and in internal/orders for enable_orders). A poll tick or a
// historical backfill of many shots can call this far more often than
// options.json could plausibly change, so within cacheTTL of the last check
// this skips the os.Stat entirely and just returns the cached value; the
// fields here are manual Configuration-UI toggles, not something that needs
// sub-second pickup, so a short TTL costs nothing in practice while saving a
// stat call on every hot-path call.
//
// path keys the cache on the file it was read from as well as its mtime:
// OptionsFile is a var, so a caller that repoints it (tests do; production
// sets it once) must not keep seeing the previous file's cached value within
// cacheTTL.
var optionsCache struct {
	mu      sync.Mutex
	valid   bool // false until the first call computes a result -- true whether that came from a stat'd options.json or the #764 no-file/env-var fallback
	path    string
	mtime   time.Time
	checked time.Time
	value   options
}

// cacheTTL is how long Options() trusts its cached value without even checking
// options.json's mtime -- sized for a 1-second poll caller
// (internal/system/poll.go's pollViaGaggiuinoStatus), the tightest hot path
// that calls this.
const cacheTTL = 5 * time.Second

// Options returns the options.json fields more than one internal package needs
// -- debug_logging, allowed_hosts and enable_orders -- from one read+parse of
// OptionsFile, cached by mtime.
//
// Fallbacks match each field's original per-package reader exactly: a missing
// or unparseable options.json falls back to the environment for the two
// booleans (GLP_DEBUG_LOGGING / GLP_ENABLE_ORDERS, #764 standalone Docker with
// no Supervisor) and to "" for allowed_hosts (the caller appends
// GLP_ALLOWED_HOSTS itself); a present-but-valid file yields its own values,
// with an absent key read as false/"".
//
// Lives in this standalone leaf package rather than internal/system, because
// internal/machines needs debug_logging too (registry.go's
// Registry.LogRegistrySnapshot) and internal/system already imports
// internal/machines -- importing internal/system back from internal/machines
// would be a cycle. Both of those packages, plus cmd/server and internal/orders,
// import this one instead of each maintaining an independent copy of the same
// read+parse+mtime-cache logic.
func Options() options {
	optionsCache.mu.Lock()
	defer optionsCache.mu.Unlock()

	if optionsCache.valid && optionsCache.path == OptionsFile && time.Since(optionsCache.checked) < cacheTTL {
		return optionsCache.value
	}

	info, statErr := os.Stat(OptionsFile)
	if statErr == nil && optionsCache.valid && optionsCache.path == OptionsFile && info.ModTime().Equal(optionsCache.mtime) {
		optionsCache.checked = time.Now()
		return optionsCache.value
	}

	value := parseOptionsFile()
	// valid latches true even when options.json is permanently absent (#764
	// standalone Docker): that outcome is just as cacheable as a successfully
	// stat'd file, and leaving valid false here defeated the TTL fast-path
	// above for this configuration -- every call re-ran the failing os.Stat and
	// os.ReadFile instead of trusting the cache like the file-exists case does.
	// mtime is left untouched when statErr != nil so the mtime shortcut above
	// still only ever fires once we've actually stat'd a real file.
	optionsCache.valid = true
	optionsCache.path = OptionsFile
	if statErr == nil {
		optionsCache.mtime = info.ModTime()
	}
	optionsCache.value = value
	optionsCache.checked = time.Now()
	return value
}

// parseOptionsFile does Options()'s actual read+parse+fallback chain -- split
// out so Options itself only holds the cache-check/cache-store logic, matching
// internal/system/options.go's own parsePreheatMinutesFile/parseStatusOptionsFile
// split.
func parseOptionsFile() options {
	data, err := os.ReadFile(OptionsFile)
	if err != nil {
		return optionsFromEnv()
	}
	var raw struct {
		DebugLogging bool   `json:"debug_logging"`
		AllowedHosts string `json:"allowed_hosts"`
		EnableOrders bool   `json:"enable_orders"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return optionsFromEnv()
	}
	return options{
		DebugLogging: raw.DebugLogging,
		AllowedHosts: raw.AllowedHosts,
		EnableOrders: raw.EnableOrders,
	}
}

// optionsFromEnv is parseOptionsFile's whole-file-missing/unparseable fallback
// (#764): each field keeps the env-var default its original per-package reader
// used. allowed_hosts has no env fallback here -- it is "" either way.
func optionsFromEnv() options {
	return options{
		DebugLogging: os.Getenv("GLP_DEBUG_LOGGING") == "true",
		EnableOrders: os.Getenv("GLP_ENABLE_ORDERS") == "true",
	}
}

// IsDebugLoggingEnabled reports whether debug logging is on: off by default,
// falling back to GLP_DEBUG_LOGGING (#764, standalone Docker) when options.json
// is missing or doesn't parse. Thin wrapper over Options()'s shared cache.
func IsDebugLoggingEnabled() bool {
	return Options().DebugLogging
}
