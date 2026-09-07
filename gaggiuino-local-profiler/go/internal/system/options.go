package system

import (
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"time"
)

// This mirrors internal/orders/options.go's isOrdersEnabled(): a narrow,
// single-field read of /data/options.json (written by the Supervisor),
// rather than a full loadOptions() facade — see that file's doc comment
// for the trade-off reasoning, which applies identically here.

// preheatMinutesCache caches loadPreheatMinutes()'s parsed result, keyed on
// options.json's mtime. #901 code review: loadPreheatMinutes() used to
// re-read and re-parse the file on every call, including pollTick's 1s hot
// path (it's also read on every preheat-update SSE push and every
// preheat-state change) — for a value the Supervisor only ever rewrites
// when the user edits the add-on's config in HA's UI, a handful of times a
// year at most. A changed file is still picked up promptly: every call
// still os.Stat's the file (cheap relative to the ReadFile+Unmarshal this
// now skips on a cache hit) and re-parses the moment the mtime moves.
var preheatMinutesCache struct {
	mu      sync.Mutex
	valid   bool // false until the first os.Stat succeeds
	mtime   time.Time
	minutes int
}

// loadPreheatMinutes ports `Math.max(1, parseInt(opts.preheat_time) || 20)`,
// used by buildPreheatResponse/_checkReadyByPreheat/_checkPreheatNotify.
// Falls back to GLP_PREHEAT_TIME (#764, standalone Docker with no
// Supervisor) when options.json doesn't exist/parse, then to 20, matching
// loadOptions()'s own fallback chain.
func loadPreheatMinutes() int {
	preheatMinutesCache.mu.Lock()
	defer preheatMinutesCache.mu.Unlock()

	info, statErr := os.Stat(defaultOptionsFile)
	if statErr == nil && preheatMinutesCache.valid && info.ModTime().Equal(preheatMinutesCache.mtime) {
		return preheatMinutesCache.minutes
	}

	minutes := parsePreheatMinutesFile()
	preheatMinutesCache.valid = statErr == nil
	if statErr == nil {
		preheatMinutesCache.mtime = info.ModTime()
	}
	preheatMinutesCache.minutes = minutes
	return minutes
}

// parsePreheatMinutesFile does loadPreheatMinutes()'s actual read+parse+
// fallback chain — split out so loadPreheatMinutes itself only holds the
// cache-check/cache-store logic.
func parsePreheatMinutesFile() int {
	if data, err := os.ReadFile(defaultOptionsFile); err == nil {
		var opts struct {
			PreheatTime json.Number `json:"preheat_time"`
		}
		if err := json.Unmarshal(data, &opts); err == nil {
			if n, err := opts.PreheatTime.Int64(); err == nil && n > 0 {
				return int(n)
			}
		}
		return 20
	}
	if n, err := strconv.Atoi(os.Getenv("GLP_PREHEAT_TIME")); err == nil && n > 0 {
		return n
	}
	return 20
}

// statusOptionsCache caches loadStatusOptions()'s parsed result, keyed on
// options.json's mtime — the same mtime-cache pattern preheatMinutesCache
// above already established for the identical problem (#901 code review:
// isOrdersEnabled/isApiPortExposed/loadSyncIntervalMinutes were added to
// GET /api/status, another hot path polled every 10s by glp-integration's
// GlpDataCoordinator, without picking up that pattern — each did its own
// unconditional os.ReadFile+json.Unmarshal on every call). Unlike
// preheatMinutesCache, these three fields are always read together from
// the same request, so one cached parse covers all three instead of three
// independent caches.
var statusOptionsCache struct {
	mu    sync.Mutex
	valid bool // false until the first os.Stat succeeds
	mtime time.Time
	opts  statusOptions
}

type statusOptions struct {
	ordersEnabled       bool
	apiPortExposed      bool
	syncIntervalMinutes int
}

// loadStatusOptions returns the cached (or freshly parsed, on a cache miss)
// options.json fields isOrdersEnabled/isApiPortExposed/
// loadSyncIntervalMinutes below all delegate to.
func loadStatusOptions() statusOptions {
	statusOptionsCache.mu.Lock()
	defer statusOptionsCache.mu.Unlock()

	info, statErr := os.Stat(defaultOptionsFile)
	if statErr == nil && statusOptionsCache.valid && info.ModTime().Equal(statusOptionsCache.mtime) {
		return statusOptionsCache.opts
	}

	opts := parseStatusOptionsFile()
	statusOptionsCache.valid = statErr == nil
	if statErr == nil {
		statusOptionsCache.mtime = info.ModTime()
	}
	statusOptionsCache.opts = opts
	return opts
}

// parseStatusOptionsFile does loadStatusOptions()'s actual read+parse+
// fallback chain — split out so loadStatusOptions itself only holds the
// cache-check/cache-store logic, matching parsePreheatMinutesFile's split
// above.
func parseStatusOptionsFile() statusOptions {
	data, err := os.ReadFile(defaultOptionsFile)
	if err != nil {
		return statusOptions{
			ordersEnabled:       os.Getenv("GLP_ENABLE_ORDERS") == "true",
			apiPortExposed:      os.Getenv("GLP_EXPOSE_API_PORT") != "false",
			syncIntervalMinutes: syncIntervalMinutesFromEnv(),
		}
	}
	var raw struct {
		EnableOrders  bool        `json:"enable_orders"`
		ExposeAPIPort *bool       `json:"expose_api_port"`
		SyncInterval  json.Number `json:"sync_interval"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return statusOptions{
			ordersEnabled:       os.Getenv("GLP_ENABLE_ORDERS") == "true",
			apiPortExposed:      os.Getenv("GLP_EXPOSE_API_PORT") != "false",
			syncIntervalMinutes: syncIntervalMinutesFromEnv(),
		}
	}

	// key absent from an otherwise-valid options.json -- undefined !== false
	apiPortExposed := true
	if raw.ExposeAPIPort != nil {
		apiPortExposed = *raw.ExposeAPIPort
	}
	syncInterval := 5
	if n, err := raw.SyncInterval.Int64(); err == nil && n > 0 {
		syncInterval = int(n)
	}
	return statusOptions{
		ordersEnabled:       raw.EnableOrders,
		apiPortExposed:      apiPortExposed,
		syncIntervalMinutes: syncInterval,
	}
}

// syncIntervalMinutesFromEnv is loadSyncIntervalMinutes's whole-file-missing
// fallback: GLP_SYNC_INTERVAL (#764) then 5. Only ever consulted when
// options.json itself is missing/unparseable, never merged in field-by-field
// against an otherwise-present file — same distinction apiPortExposed's
// key-absent-vs-file-absent branches draw above.
func syncIntervalMinutesFromEnv() int {
	if n, err := strconv.Atoi(os.Getenv("GLP_SYNC_INTERVAL")); err == nil && n > 0 {
		return n
	}
	return 5
}

// isOrdersEnabled duplicates internal/orders' own isOrdersEnabled() verbatim
// (see that package's options.go for the reasoning): a narrow,
// single-field read rather than an import of internal/orders, which this
// package doesn't otherwise depend on. GET /api/status's ordersFeature
// field is this copy's only caller.
func isOrdersEnabled() bool {
	return loadStatusOptions().ordersEnabled
}

// isApiPortExposed ports lib/data.js's isApiPortExposed() /
// loadOptions().expose_api_port !== false. Opposite default from
// isOrdersEnabled/loadPreheatMinutes above: a missing/unparseable
// options.json, or a valid options.json that simply doesn't have this key
// yet (an install predating #803), must resolve to true — only an
// explicit JSON `false` turns it off. See routes/system.js's GET
// /api/token doc comment (ported verbatim in handlers.go's getToken) for
// why the default can't be closed.
func isApiPortExposed() bool {
	return loadStatusOptions().apiPortExposed
}

// loadSyncIntervalMinutes ports `opts.sync_interval || 5` — GET
// /api/status's syncInterval field. A missing/unparseable options.json
// falls back to GLP_SYNC_INTERVAL (#764) then 5; a valid options.json that
// simply lacks (or has a non-positive) sync_interval falls straight to 5,
// matching loadOptions()'s own per-branch fallback chain.
func loadSyncIntervalMinutes() int {
	return loadStatusOptions().syncIntervalMinutes
}
