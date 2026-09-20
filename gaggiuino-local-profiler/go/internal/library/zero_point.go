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
// mirroring resetBurrs' read-mutate-save shape (handlers_grinders.go). since
// is the millisecond epoch when this zero point became active; pass 0 to use
// the current time (same as before this parameter existed). History is kept
// sorted by since so zeroPointAtTime stays correct after retroactive inserts.
// Idempotent: "now" inserts skip when the latest value is already equal;
// retroactive inserts skip when the exact (since,value) pair already exists.
// since is the entry's natural key — a retroactive insert whose since
// collides with an existing entry replaces that entry's value rather than
// appending a second one alongside it, so history never carries two
// activations claiming the same instant (which DELETE .../since could not
// otherwise tell apart, and which would make zeroPointAtTime's "latest
// since <= timestamp" pick depend on slice order after an equal-key sort).
func SetGrinderZeroPoint(repo *Repository, id int64, zeroPoint float64, since int64) (Entity, bool, error) {
	retroactive := since != 0
	if !retroactive {
		since = newID()
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, false, err
	}
	idx := findGrinderIndex(lib, id)
	if idx == -1 {
		return nil, false, nil
	}
	grinder := lib.Grinders[idx]
	history := zeroPointHistoryOf(grinder)
	// Idempotency:
	//   "now" inserts (retroactive=false): skip when latest value already equals
	//     the new value — same behaviour as before this parameter was added.
	//   Retroactive inserts: skip only when the exact (since,value) pair exists,
	//     so callers can insert past entries idempotently without stomping different
	//     values that might have been recorded at neighboring times.
	skip := false
	if !retroactive {
		if current, ok := currentGrinderZeroPoint(grinder); ok && current == zeroPoint {
			skip = true
		}
	} else {
		for _, e := range history {
			if e.since == since && e.zeroPoint == zeroPoint {
				skip = true
				break
			}
		}
	}
	if !skip {
		raw, _ := grinder["zeroPointHistory"].([]any)
		if retroactive {
			deduped := raw[:0:0]
			for _, r := range raw {
				if entry, ok := r.(Entity); ok {
					if s, ok2 := idOf(entry, "since"); ok2 && s == since {
						continue // replaced below
					}
				}
				deduped = append(deduped, r)
			}
			raw = deduped
		}
		raw = append(raw, Entity{"zeroPoint": zeroPoint, "since": since})
		// Keep sorted by since so zeroPointAtTime's linear scan stays correct.
		sort.Slice(raw, func(i, j int) bool {
			ei, _ := raw[i].(Entity)
			ej, _ := raw[j].(Entity)
			si, _ := idOf(ei, "since")
			sj, _ := idOf(ej, "since")
			return si < sj
		})
		grinder["zeroPointHistory"] = raw
	}
	lib.Grinders[idx] = grinder
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, false, err
	}
	return grinder, true, nil
}

// DeleteGrinderZeroPointEntry removes the history entry with the given since
// value. Returns (grinder, true, nil) on success, (nil, false, nil) when the
// grinder doesn't exist, and (nil, false, err) on I/O error. Silently succeeds
// when no entry with that since exists (idempotent).
func DeleteGrinderZeroPointEntry(repo *Repository, id int64, since int64) (Entity, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, false, err
	}
	idx := findGrinderIndex(lib, id)
	if idx == -1 {
		return nil, false, nil
	}
	grinder := lib.Grinders[idx]
	raw, _ := grinder["zeroPointHistory"].([]any)
	filtered := make([]any, 0, len(raw))
	for _, r := range raw {
		entry, ok := r.(Entity)
		if !ok {
			continue
		}
		s, ok := idOf(entry, "since")
		if ok && s == since {
			continue // remove this entry
		}
		filtered = append(filtered, r)
	}
	grinder["zeroPointHistory"] = filtered
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
