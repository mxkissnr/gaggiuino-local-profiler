package system

import "time"

// These mirror the relevant subset of lib/constants.js's exported values —
// see that file's own comments for the reasoning behind each number.
const (
	// tempHistoryMax is TEMP_HISTORY_MAX: max rolling history entries (1 per
	// second of live polling).
	tempHistoryMax = 60

	// tempStableMin/tempStableVar are TEMP_STABLE_MIN/TEMP_STABLE_VAR:
	// isTempStable()'s stability window (seconds) and max allowed range
	// (°C) over it.
	tempStableMin = 30
	tempStableVar = 1.5

	// preheatStateTTL is PREHEAT_STATE_TTL: a persisted switchOnAt/
	// switchOffAt older than this is treated as stale and dropped on load,
	// rather than resuming a preheat session from days ago.
	preheatStateTTL = 24 * time.Hour

	// warmTempMin/warmOffMaxMS are WARM_TEMP_MIN/WARM_OFF_MAX_MS:
	// isStillWarm()'s "still hot enough to skip a fresh preheat" heuristic.
	warmTempMin   = 80.0
	warmOffMaxDur = 5 * time.Minute

	// liveStaleAfter mirrors the poll loop's own 1s cadence: a poll tick
	// this package's Poller runs at, matching lib/poll.js's
	// setInterval(pollLive, 1000).
	pollInterval = 1 * time.Second

	// backgroundHaCheckInterval / preheatWatchInterval mirror server.js's
	// two 30s setInterval calls (backgroundHaCheck, startPreheatWatcher).
	backgroundHaCheckInterval = 30 * time.Second
	preheatWatchInterval      = 30 * time.Second

	// preheatStateFile mirrors PREHEAT_STATE_FILE.
	preheatStateFile = "/data/preheat_state.json"
)

// defaultOptionsFile mirrors OPTIONS_FILE. A var, not a const, so
// options_test.go can point it at a throwaway file instead of the real
// `/data/options.json` (same testing-seam pattern as
// internal/backup/handlers.go's restoreUnzipEntryLimit).
var defaultOptionsFile = "/data/options.json"
