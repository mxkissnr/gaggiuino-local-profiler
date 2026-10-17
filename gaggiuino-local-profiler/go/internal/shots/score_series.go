package shots

import (
	"bytes"
	stdjson "encoding/json"

	json "github.com/goccy/go-json"
)

func floatSlice(v any) []float64 {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]float64, 0, len(arr))
	for _, x := range arr {
		if f, ok := x.(float64); ok {
			out = append(out, f)
		}
	}
	return out
}

// scoreSeries is the small set of datapoint arrays CalcShotScoreDetail and
// ComputeShotMetrics actually read. hydrateRow keeps a shot's datapoints as
// raw JSON bytes (see model.go), so the list scorer parses only these five
// series — typed, never boxed through []any — instead of decoding the whole
// (much larger) datapoints object per shot (#951).
type scoreSeries struct {
	pressure          []float64
	temperature       []float64
	targetTemperature []float64
	timeInShot        []float64
	// weight follows the `d.shotWeight || d.weight` rule: shotWeight wins
	// whenever it is present and non-null, even when it is an empty array (in
	// which case weight is deliberately NOT consulted as a fallback).
	weight []float64
}

// extractScoreSeries pulls the scoring series out of a shot's "datapoints"
// value in whichever shape it arrives: a json.RawMessage (hydrateRow) or a
// map[string]any (a Shot built by hand in tests / demo seed data).
func extractScoreSeries(v any) scoreSeries {
	switch t := v.(type) {
	case stdjson.RawMessage:
		return scoreSeriesFromRaw(t)
	case []byte:
		return scoreSeriesFromRaw(t)
	case map[string]any:
		return scoreSeriesFromMap(t)
	default:
		return scoreSeries{}
	}
}

func scoreSeriesFromMap(d map[string]any) scoreSeries {
	s := scoreSeries{
		pressure:          floatSlice(d["pressure"]),
		temperature:       floatSlice(d["temperature"]),
		targetTemperature: floatSlice(d["targetTemperature"]),
		timeInShot:        floatSlice(d["timeInShot"]),
	}
	if v, ok := d["shotWeight"]; ok && v != nil {
		s.weight = floatSlice(v)
	} else if v, ok := d["weight"]; ok && v != nil {
		s.weight = floatSlice(v)
	}
	return s
}

func scoreSeriesFromRaw(raw stdjson.RawMessage) scoreSeries {
	var s scoreSeries
	if isJSONNull(raw) {
		return s
	}
	var m map[string]stdjson.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return s
	}
	s.pressure = decodeFloatArray(m["pressure"])
	s.temperature = decodeFloatArray(m["temperature"])
	s.targetTemperature = decodeFloatArray(m["targetTemperature"])
	s.timeInShot = decodeFloatArray(m["timeInShot"])
	if v, ok := m["shotWeight"]; ok && !isJSONNull(v) {
		s.weight = decodeFloatArray(v)
	} else if v, ok := m["weight"]; ok && !isJSONNull(v) {
		s.weight = decodeFloatArray(v)
	}
	return s
}

// hasChartSeries reports whether a shot's "datapoints" value carries a
// non-empty timeInShot or pressure series — GET /api/shots's hasChartData
// slim-row bool (the frontend's live ref-overlay picker and any
// "curves available?" check read it instead of probing datapoints, which
// the slim row no longer carries). Cheap on both shapes: a hand-built
// map[string]any is a length check; a hydrateRow RawMessage is one shallow
// object tokenize (no per-sample number parsing), materially cheaper than
// the full extractScoreSeries decode the scorer does.
func hasChartSeries(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		return len(floatSlice(t["timeInShot"])) > 0 || len(floatSlice(t["pressure"])) > 0
	case stdjson.RawMessage:
		return rawHasNonEmptyArray(t)
	case []byte:
		return rawHasNonEmptyArray(t)
	default:
		return false
	}
}

func rawHasNonEmptyArray(raw []byte) bool {
	if isJSONNull(raw) {
		return false
	}
	var m map[string]stdjson.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	for _, k := range [...]string{"timeInShot", "pressure"} {
		v := bytes.TrimSpace(m[k])
		if len(v) >= 2 && v[0] == '[' && string(v) != "[]" {
			return true
		}
	}
	return false
}

// tempStabilityDev is the mean absolute deviation of the temperature series
// from its target, in °C (both series are the ×10-scaled GLP convention,
// hence the /10). Returned per GET /api/shots row as `tempStabilityDev` so
// the Analytics machine-comparison's "Ø stability" column doesn't need every
// shot's curve client-side (#957 decision 3 / step 13). nil when the shot has
// no usable temp+target pair.
func tempStabilityDev(v any) *float64 {
	var temp, target []float64
	switch t := v.(type) {
	case map[string]any:
		temp, target = floatSlice(t["temperature"]), floatSlice(t["targetTemperature"])
	case stdjson.RawMessage:
		temp, target = tempTargetFromRaw(t)
	case []byte:
		temp, target = tempTargetFromRaw(t)
	default:
		return nil
	}
	n := len(temp)
	if len(target) < n {
		n = len(target)
	}
	var sum float64
	var count int
	for i := 0; i < n; i++ {
		// #1688: skip a failed thermocouple read (stored as exactly 0) as well
		// as a missing target sample, so a dropout is not counted as a ~90 C
		// deviation and the metric matches the score's cleaned series.
		if target[i] == 0 || temp[i] == 0 {
			continue
		}
		d := temp[i] - target[i]
		if d < 0 {
			d = -d
		}
		sum += d / 10
		count++
	}
	if count == 0 {
		return nil
	}
	dev := sum / float64(count)
	return &dev
}

func tempTargetFromRaw(raw []byte) (temp, target []float64) {
	if isJSONNull(raw) {
		return nil, nil
	}
	var m map[string]stdjson.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil
	}
	return decodeFloatArray(m["temperature"]), decodeFloatArray(m["targetTemperature"])
}

func isJSONNull(r stdjson.RawMessage) bool {
	t := bytes.TrimSpace(r)
	return len(t) == 0 || string(t) == "null"
}

// decodeFloatArray parses a JSON number array, dropping any null element —
// byte-for-byte matching the map/[]any path's floatSlice, which skips
// anything that isn't a float64 (a JSON null decodes to a nil interface and
// is skipped there). Decoding straight into []float64 would instead turn a
// null into a 0, so a shot with a stray null in a series would score
// differently on /shots.json (this path) than in the detail view
// (DatapointsMap -> floatSlice). Decoding into []*float64 keeps the fast,
// unboxed path while preserving the drop-null semantics; a non-numeric
// element (string/bool) still errors and falls back to the lenient []any
// parse.
func decodeFloatArray(r stdjson.RawMessage) []float64 {
	if len(r) == 0 {
		return nil
	}
	var ptrs []*float64
	if err := json.Unmarshal(r, &ptrs); err == nil {
		out := make([]float64, 0, len(ptrs))
		for _, p := range ptrs {
			if p != nil {
				out = append(out, *p)
			}
		}
		return out
	}
	var anyArr []any
	if err := json.Unmarshal(r, &anyArr); err != nil {
		return nil
	}
	return floatSlice(anyArr)
}

func divAll(vals []float64, d float64) []float64 {
	out := make([]float64, len(vals))
	for i, v := range vals {
		out[i] = v / d
	}
	return out
}

func toMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// toFloat accepts both float64 (every number decoded from the shot's own
// JSON `data`/`annotation` blob, e.g. ann.dose/ann.tds) and int64 (the
// fixed `duration` column hydrateRow scans as an int64, not a float64) —
// shot["duration"] is the only field CalcShotScoreDetail reads that can
// arrive as either, depending on whether the caller built the Shot via
// hydrateRow or by hand (as this package's own tests do).
func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}
