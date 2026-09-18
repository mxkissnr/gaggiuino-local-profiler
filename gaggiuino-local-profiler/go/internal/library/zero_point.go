package library

import "sort"

// A grinder's zeroPointHistory is a chronological log of every zero-point
// activation: {zeroPoint, since}, since being the timestamp (ms) that value
// became active. There's no separate "current zeroPoint" field — the
// current value is simply the last (most recent) entry, so there's only
// ever one place a grinder's zero point can disagree with itself. A
// grinder that has never had a zero point set has an empty/absent history
// — the whole feature is opt-in per grinder and inert (shots display and
// compare using their raw recorded grindSetting, unchanged) until the user
// sets one.

type zeroPointEntry struct {
	zeroPoint float64
	since     int64
}

func zeroPointHistoryOf(grinder Entity) []zeroPointEntry {
	raw, _ := grinder["zeroPointHistory"].([]any)
	out := make([]zeroPointEntry, 0, len(raw))
	for _, r := range raw {
		entry, ok := r.(Entity)
		if !ok {
			continue
		}
		zp, ok := jsParseFloat(entry["zeroPoint"])
		if !ok {
			continue
		}
		since, ok := idOf(entry, "since")
		if !ok {
			continue
		}
		out = append(out, zeroPointEntry{zeroPoint: zp, since: since})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].since < out[j].since })
	return out
}

// currentGrinderZeroPoint returns the most recently activated zero point.
// ok=false for a grinder that has never had one set.
func currentGrinderZeroPoint(grinder Entity) (float64, bool) {
	history := zeroPointHistoryOf(grinder)
	if len(history) == 0 {
		return 0, false
	}
	return history[len(history)-1].zeroPoint, true
}

// zeroPointAtTime finds the zero point that was active at timestampMs — the
// latest history entry whose since <= timestampMs. ok=false when the
// timestamp predates the grinder's very first recorded zero point: there is
// no way to know what it was before tracking began, so callers must leave
// such a shot's grind setting uncorrected rather than guess.
func zeroPointAtTime(grinder Entity, timestampMs int64) (float64, bool) {
	history := zeroPointHistoryOf(grinder)
	value, ok := 0.0, false
	for _, e := range history {
		if e.since > timestampMs {
			break
		}
		value, ok = e.zeroPoint, true
	}
	return value, ok
}

// SetGrinderZeroPoint appends a new zero-point activation for grinder id,
// mirroring resetBurrs' read-mutate-save shape (handlers_grinders.go). A
// no-op on the history (still succeeds) when the new value equals the
// grinder's current one, so a debounced frontend input re-sending the same
// value repeatedly can't pile up redundant entries.
func SetGrinderZeroPoint(repo *Repository, id int64, zeroPoint float64) (Entity, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, false, err
	}
	idx := findGrinderIndex(lib, id)
	if idx == -1 {
		return nil, false, nil
	}
	grinder := lib.Grinders[idx]
	if current, ok := currentGrinderZeroPoint(grinder); !ok || current != zeroPoint {
		history, _ := grinder["zeroPointHistory"].([]any)
		grinder["zeroPointHistory"] = append(history, Entity{"zeroPoint": zeroPoint, "since": newID()})
	}
	lib.Grinders[idx] = grinder
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, false, err
	}
	return grinder, true, nil
}

// RelativeGrindSetting normalizes a historical grind-setting value to what
// it would read on the grinder TODAY, correcting for any zero-point change
// (e.g. after cleaning) between when the shot was pulled and now — so
// grind-adjustment suggestions/comparisons built from shot history stay
// meaningful across a zero-point reset without every past shot's recorded
// value needing to be rewritten. ok=false (value returned unchanged) when
// the grinder never tracked a zero point, or the shot predates the
// earliest recorded one — there's nothing to correct against.
func RelativeGrindSetting(grinder Entity, value float64, shotTimestampMs int64) (float64, bool) {
	nowZP, hasNow := currentGrinderZeroPoint(grinder)
	thenZP, hasThen := zeroPointAtTime(grinder, shotTimestampMs)
	if !hasNow || !hasThen {
		return value, false
	}
	return value - thenZP + nowZP, true
}
