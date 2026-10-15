package system

import (
	"log"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/config"
)

// This file's options.json reads all delegate to internal/config's shared,
// mtime+TTL-cached Options() (#1622 slice 8). Until then this file had its own
// two mtime caches over a private defaultOptionsFile -- preheatMinutesCache
// (preheat_time) and statusOptionsCache (enable_orders, expose_api_port,
// sync_interval) -- with enable_orders parsed twice, once here and once in
// internal/config. One shared reader now covers all of them; the functions
// below are thin wrappers kept for this package's callers.
//
// The only visible difference is the TTL: config.Options() trusts its cached
// value for up to 5s without even stat'ing options.json, where the old caches
// re-stat'd on every call. A changed preheat_time/sync_interval picked up 5s
// late is acceptable -- the Supervisor restarts the app on an option change
// anyway.

// loadPreheatMinutes reads the preheat_time option, defaulting to 20, used by
// buildPreheatResponse/_checkReadyByPreheat/_checkPreheatNotify. See
// config.Options for the fallback chain (a missing/unparseable options.json
// falls back to GLP_PREHEAT_TIME, #764 standalone Docker with no Supervisor,
// then 20).
func loadPreheatMinutes() int {
	return config.Options().PreheatMinutes
}

// isOrdersEnabled reports whether the orders feature is on (GET /api/status's
// ordersFeature). See config.Options for the fallback chain.
func isOrdersEnabled() bool {
	return config.Options().EnableOrders
}

// isApiPortExposed reports whether expose_api_port is enabled. Opposite
// default from isOrdersEnabled/loadPreheatMinutes: a missing/unparseable
// options.json, or a valid options.json that simply doesn't have this key yet
// (an install predating #803), must resolve to true -- only an explicit JSON
// `false` turns it off. See handlers.go's getToken doc comment for why the
// default can't be closed.
func isApiPortExposed() bool {
	return config.Options().APIPortExposed
}

// loadSyncIntervalMinutes returns GET /api/status's syncInterval field. See
// config.Options for the fallback chain (a missing/unparseable options.json
// falls back to GLP_SYNC_INTERVAL, #764, then 5).
func loadSyncIntervalMinutes() int {
	return config.Options().SyncIntervalMinutes
}

// isDebugLoggingEnabled delegates to internal/config's shared, mtime-cached
// implementation (#977 follow-up code review, round 4) rather than
// bundling debug_logging into this package's options reads --
// internal/machines needs the identical check and can't import this
// package (see internal/config.IsDebugLoggingEnabled's doc comment for the
// cycle this was extracted to break), so both packages now share one
// implementation instead of keeping independent copies.
func isDebugLoggingEnabled() bool {
	return config.IsDebugLoggingEnabled()
}

// debugLogf logs with a "[debug]" prefix, but only when
// isDebugLoggingEnabled(). See sync.go/poll.go for the call sites this backs.
func debugLogf(format string, args ...any) {
	if isDebugLoggingEnabled() {
		log.Printf("[debug] "+format, args...)
	}
}

// IsDebugLoggingEnabled/DebugLogf are isDebugLoggingEnabled/debugLogf exposed
// for internal/importer's HTML/JSON fetch traces (#977 follow-up code review):
// internal/system<->internal/importer has no import cycle (unlike
// internal/machines, which is imported BY internal/system -- see
// internal/config.IsDebugLoggingEnabled's doc comment for how that cycle is
// broken instead), so importer just calls straight through to this package's
// own wrapper around the shared internal/config implementation.
func IsDebugLoggingEnabled() bool          { return isDebugLoggingEnabled() }
func DebugLogf(format string, args ...any) { debugLogf(format, args...) }
