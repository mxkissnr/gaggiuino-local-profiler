package system

import (
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/datadir"
)

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

	// readyByGrace is how far past its target a ready-by time may be before it
	// counts as stale: a target more than this far in the past is dropped
	// without switching the machine on. The window also absorbs the clock skew
	// between a browser's targetAt and the host's clock.
	readyByGrace = 5 * time.Minute

	// warmTempMin/warmOffMaxDur are isStillWarm()'s "still hot enough to
	// skip a fresh preheat" heuristic.
	warmTempMin   = 80.0
	warmOffMaxDur = 5 * time.Minute

	// pollInterval is the live-polling cadence: one poll tick per second.
	pollInterval = 1 * time.Second

	// maxLiveAccumPoints caps a live session's per-tick time series at one
	// hour (3600 ticks at pollInterval), so a machine stuck in a brew or
	// steam/flush/descale mode cannot grow the accumulator without bound.
	maxLiveAccumPoints = 3600

	// firmwareNameFetchTimeout bounds the one-off GetSettings("system") request
	// the live poll makes to read a Gaggiuino's firmware-set machine name
	// (#1454).
	firmwareNameFetchTimeout = 3 * time.Second

	// firmwareNameRetryInterval throttles a failed firmware-name fetch: a
	// machine whose settings endpoint keeps erroring costs at most one extra
	// request per interval, never one per 1s poll tick (#1454).
	firmwareNameRetryInterval = 60 * time.Second

	// backgroundHaCheckInterval / preheatWatchInterval are the cadences of the
	// two 30s background tasks: HA reachability checks and preheat watching.
	backgroundHaCheckInterval = 30 * time.Second
	preheatWatchInterval      = 30 * time.Second
)

// preheatStateFile is where the preheat session state is persisted, under
// datadir.Root (the real data directory in production, a per-test directory
// under `go test`). A var, not a const, so it is resolved through the data-dir
// seam.
var preheatStateFile = datadir.Path("preheat_state.json")

// defaultOptionsFile is a var, not a const, so
// options_test.go can point it at a throwaway file instead of the real
// options.json under the data directory (same testing-seam pattern as
// internal/backup/handlers.go's restoreUnzipEntryLimit).
var defaultOptionsFile = datadir.Path("options.json")
