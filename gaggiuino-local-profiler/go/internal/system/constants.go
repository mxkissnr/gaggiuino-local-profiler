package system

import "time"

const (
	// tempHistoryMax is the max number of rolling history entries (1 per
	// second of live polling).
	tempHistoryMax = 60

	// tempStableMin/tempStableVar are isTempStable()'s stability window
	// (seconds) and max allowed range (°C) over it.
	tempStableMin = 30
	tempStableVar = 1.5

	// preheatStateTTL bounds a persisted switchOnAt/
	// switchOffAt older than this is treated as stale and dropped on load,
	// rather than resuming a preheat session from days ago.
	preheatStateTTL = 24 * time.Hour

	// warmTempMin/warmOffMaxDur are isStillWarm()'s "still hot enough to
	// skip a fresh preheat" heuristic.
	warmTempMin   = 80.0
	warmOffMaxDur = 5 * time.Minute

	// pollInterval is the live-polling cadence: one poll tick per second.
	pollInterval = 1 * time.Second

	// backgroundHaCheckInterval / preheatWatchInterval are the cadences of the
	// two 30s background tasks: HA reachability checks and preheat watching.
	backgroundHaCheckInterval = 30 * time.Second
	preheatWatchInterval      = 30 * time.Second

	// preheatStateFile is where the preheat session state is persisted.
	preheatStateFile = "/data/preheat_state.json"
)

// defaultOptionsFile is a var, not a const, so
// options_test.go can point it at a throwaway file instead of the real
// `/data/options.json` (same testing-seam pattern as
// internal/backup/handlers.go's restoreUnzipEntryLimit).
var defaultOptionsFile = "/data/options.json"
