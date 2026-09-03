package shots

import (
	"bytes"
	"database/sql"
	stdjson "encoding/json"
	"fmt"

	json "github.com/goccy/go-json"
)

// MaxShotID mirrors lib/constants.js's MAX_SHOT_ID: the highest value a
// shot id (native or multi-machine synthetic) can ever take.
const MaxShotID = 99_999_999

// machineIDOffset mirrors lib/machines/index.js's MACHINE_ID_OFFSET. That
// file (lib/machines/index.js -> internal/machines, still a Phase 0
// placeholder) isn't ported yet, so the small amount of arithmetic this
// package needs from it (toNativeShotID/ownerOfShotID) is duplicated here
// rather than imported. Move these two functions to internal/machines and
// have this package call them once the machines domain lands.
const machineIDOffset = 10_000_000

// toNativeShotID ports lib/machines/index.js's toNativeShotId(machineId,
// globalId): the machine's own shot number, as opposed to the
// globally-unique synthetic id used everywhere internally.
func toNativeShotID(machineID, globalID int64) int64 {
	if machineID == 1 {
		return globalID
	}
	return globalID - machineID*machineIDOffset
}

// Shot is a hydrated shot record: the fixed shots-table columns plus the
// arbitrary JSON payload the Gaggiuino machine (or GaggiMate adapter)
// reported, merged into one map exactly the way lib/repositories/
// ShotRepository.js's _hydrate() spreads `...rest` over the fixed fields —
// see hydrateRow below. A map, not a struct, deliberately: the shot payload
// shape is a cross-repo contract this package must reproduce byte-for-byte
// without knowing every field the machine adapters might ever add, the same
// reason the Node original never declares a fixed shot type either.
type Shot map[string]any

// clone returns a shallow copy of s — used whenever a handler needs to add
// response-only fields (score, usedBeanTarget, ...) without mutating a
// value a caller might still hold (e.g. the previous-shot lookup result).
func (s Shot) clone() Shot {
	out := make(Shot, len(s)+2)
	for k, v := range s {
		out[k] = v
	}
	return out
}

// profileName returns shot["profileName"] as a string, or "" if absent/not
// a string/null — mirrors JS's `shot.profileName` falsy-check usage in
// ShotService.getPreviousByProfile.
func (s Shot) profileName() string {
	v, _ := s["profileName"].(string)
	return v
}

// id returns shot["id"] as an int64. Always present and always an int64 for
// any Shot produced by hydrateRow.
func (s Shot) id() int64 {
	v, _ := s["id"].(int64)
	return v
}

// machineID returns shot["machineId"], defaulting to 1 — mirrors JS's
// `shot.machineId ?? 1`.
func (s Shot) machineID() int64 {
	if v, ok := s["machineId"].(int64); ok {
		return v
	}
	return 1
}

// imageExt returns shot["image"] as a string, or "" if absent/not a
// string/null.
func (s Shot) imageExt() string {
	v, _ := s["image"].(string)
	return v
}

// rowScanner is implemented by both *sql.Row and *sql.Rows, letting
// hydrateRow serve both a single-row lookup and a multi-row Query loop.
type rowScanner interface {
	Scan(dest ...any) error
}

// selectBase ports lib/repositories/ShotRepository.js's SELECT_BASE
// verbatim: the shots<->annotations left join every repository read here
// builds on.
const selectBase = `
	SELECT s.id, s.timestamp, s.duration, s.profile_name, s.data, s.machine_id, a.data AS ann_data
	FROM shots s LEFT JOIN annotations a ON a.shot_id = s.id
`

// hydrateRow ports ShotRepository.js's _hydrate(row): scans one joined
// shots+annotations row and merges the JSON `data` blob's own keys over the
// fixed columns, then re-applies machineId/nativeId/annotation on top —
// same field set, same precedence order, as the Node original.
func hydrateRow(sc rowScanner) (Shot, error) {
	var id, timestamp, machineID int64
	var duration sql.NullInt64
	var profileName sql.NullString
	var data string
	var annData sql.NullString

	if err := sc.Scan(&id, &timestamp, &duration, &profileName, &data, &machineID, &annData); err != nil {
		return nil, err
	}
	return hydrateFields(id, timestamp, machineID, duration, profileName, data, annData)
}

// hydrateFields is hydrateRow's body after the Scan — split out so the
// keyset-page query (paging.go), which scans the same seven shot columns
// plus a few score-cache columns in one row, can reuse the exact hydration
// logic without a second Scan signature drifting from this one.
func hydrateFields(id, timestamp, machineID int64, duration sql.NullInt64, profileName sql.NullString, data string, annData sql.NullString) (Shot, error) {
	var rest map[string]any
	if data != "" {
		var raw map[string]stdjson.RawMessage
		if err := json.Unmarshal([]byte(data), &raw); err != nil {
			return nil, fmt.Errorf("shots: decoding shot %d data: %w", id, err)
		}
		rest = make(map[string]any, len(raw))
		for k, v := range raw {
			if k == "datapoints" {
				// Keep the datapoints series as raw JSON bytes instead of
				// boxing every sample into an []any: /shots.json hydrates
				// and re-serialises all 213 shots on every request and the
				// scorer only needs a handful of typed series
				// (scoreSeriesFromRaw), so the boxing + reflect-marshal of
				// these arrays was ~all of the endpoint's cost (#951). A
				// hand-built Shot (tests, demo data) still holds a
				// map[string]any here — DatapointsMap and extractScoreSeries
				// both accept either shape.
				cp := make(stdjson.RawMessage, len(v))
				copy(cp, v)
				rest[k] = cp
				continue
			}
			var val any
			if err := json.Unmarshal(v, &val); err != nil {
				return nil, fmt.Errorf("shots: decoding shot %d field %q: %w", id, k, err)
			}
			rest[k] = val
		}
	}
	if rest == nil {
		rest = map[string]any{}
	}

	shot := Shot{
		"id":        id,
		"timestamp": timestamp,
	}
	if duration.Valid {
		shot["duration"] = duration.Int64
	} else {
		shot["duration"] = nil
	}
	var pn any
	if profileName.Valid {
		pn = profileName.String
	}
	shot["profile_name"] = pn
	shot["profileName"] = pn

	for k, v := range rest {
		shot[k] = v
	}

	shot["machineId"] = machineID
	shot["nativeId"] = toNativeShotID(machineID, id)

	if annData.Valid {
		var ann map[string]any
		if err := json.Unmarshal([]byte(annData.String), &ann); err != nil {
			return nil, fmt.Errorf("shots: decoding annotation for shot %d: %w", id, err)
		}
		shot["annotation"] = ann
	} else if v, ok := rest["annotation"]; ok {
		shot["annotation"] = v
	} else {
		shot["annotation"] = map[string]any{}
	}

	return shot, nil
}

// DatapointsMap returns a shot's "datapoints" as a decoded map[string]any.
// hydrateRow keeps that value as an encoding/json.RawMessage to keep
// /shots.json fast (see there); the callers that genuinely need the decoded
// series — the shot-detail view, the share-card renderer, the achievements
// engine — go through this. A Shot built by hand (tests, demo seed data)
// that still holds a map[string]any is returned as-is; anything missing or
// null yields an empty map, never nil.
func DatapointsMap(shot Shot) map[string]any {
	if shot == nil {
		return map[string]any{}
	}
	switch t := shot["datapoints"].(type) {
	case map[string]any:
		return t
	case stdjson.RawMessage:
		return decodeDatapoints(t)
	case []byte:
		return decodeDatapoints(t)
	default:
		return map[string]any{}
	}
}

func decodeDatapoints(raw []byte) map[string]any {
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || string(trimmed) == "null" {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}
