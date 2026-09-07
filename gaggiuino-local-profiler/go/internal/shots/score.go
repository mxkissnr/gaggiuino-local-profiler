package shots

import (
	"bytes"
	stdjson "encoding/json"
	"math"
	"regexp"
	"strconv"

	json "github.com/goccy/go-json"
)

// This file ports lib/score.js verbatim: the canonical shot score (0-100)
// shared by the Node backend and frontend. Same weights (pressure 25, temp
// stability+accuracy 20, duration 20, brew ratio 20, extraction yield 20,
// channeling 15), same thresholds, same rounding.

// Bean is the subset of a library bean's fields score.js reads
// (brewTempC/brewRatio) to replace the generic fixed-band targets with the
// bean's own recommendation (#450). internal/library (Phase 0 placeholder,
// not ported yet) is what will actually resolve a shot's annotation to a
// Bean — see ComputeScoreDetail's doc comment. A nil *Bean reproduces
// score.js's behavior when no bean is passed at all: generic bands only.
type Bean struct {
	// BrewTempC is nil when the bean has no target temperature set —
	// mirrors the `typeof bean.brewTempC === 'number' && bean.brewTempC > 0`
	// guard in calcShotScoreDetail.
	BrewTempC *float64
	// BrewRatio is the bean form's own "1:X" convention (see
	// sanitize-bean.js) — empty string means "no target ratio set".
	BrewRatio string
}

// ScoreDetail mirrors calcShotScoreDetail's { score, usedBeanTarget }
// return shape. Score is nil for JS's `null` (not enough datapoints to
// score at all).
type ScoreDetail struct {
	Score          *int
	UsedBeanTarget bool
}

// jsRound matches JS's Math.round: round-half-up (towards +Infinity), not
// Go's math.Round (round-half-away-from-zero) — the two only disagree on
// negative .5 boundaries, which this package's score math never produces,
// but the distinct name documents the intent instead of leaving a bare
// math.Round call for a future reader to wonder about.
func jsRound(x float64) int {
	return int(math.Floor(x + 0.5))
}

func avg(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func maxOf(vals []float64) float64 {
	m := vals[0]
	for _, v := range vals[1:] {
		if v > m {
			m = v
		}
	}
	return m
}

// stddev ports lib/score.js's _stddev.
func stddev(vals []float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	m := avg(vals)
	var sumSq float64
	for _, v := range vals {
		sumSq += (v - m) * (v - m)
	}
	return math.Sqrt(sumSq / float64(len(vals)))
}

// detectChanneling ports lib/score.js's _detectChanneling. times may be
// shorter than pressures (mirrors JS's out-of-bounds array access
// returning undefined, which fails every comparison below and is treated
// as "skip this sample" — see the len(times) guard).
func detectChanneling(times, pressures []float64) bool {
	if len(times) == 0 || len(pressures) < 5 {
		return false
	}
	for i := 1; i < len(pressures); i++ {
		if pressures[i-1] < 5 {
			continue
		}
		if i >= len(times) || i-1 >= len(times) {
			continue
		}
		dt := times[i] - times[i-1]
		if dt <= 0 || dt > 3 {
			continue
		}
		if pressures[i-1]-pressures[i] > 1.5 {
			return true
		}
	}
	return false
}

var brewRatioPattern = regexp.MustCompile(`^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$`)

// parseBrewRatioTarget ports lib/score.js's _parseBrewRatioTarget.
func parseBrewRatioTarget(brewRatio string) (float64, bool) {
	if brewRatio == "" {
		return 0, false
	}
	m := brewRatioPattern.FindStringSubmatch(brewRatio)
	if m == nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

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
	// weight ports JS's `d.shotWeight || d.weight`: shotWeight wins whenever
	// it is present and non-null, even when it is an empty array (in which
	// case weight is deliberately NOT consulted as a fallback).
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

// tempStabilityDev ports analytics.js's _tempStability: the mean absolute
// deviation of the temperature series from its target, in °C (both series
// are the ×10-scaled GLP convention, hence the /10). Returned per GET
// /api/shots row as `tempStabilityDev` so the Analytics machine-comparison's
// "Ø stability" column doesn't need every shot's curve client-side (#957
// decision 3 / step 13). nil when the shot has no usable temp+target pair.
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
		if target[i] == 0 {
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

// CalcShotScoreDetail ports lib/score.js's calcShotScoreDetail(shot, bean)
// verbatim, operating on the same Shot map hydrateRow produces (a shot's
// "datapoints"/"duration"/"annotation" fields, addressed exactly the way
// the JS original reads shot.datapoints/shot.duration/shot.annotation).
//
// bean is always nil in this phase: resolving a shot's annotation to its
// library bean (#450) is LibraryService.resolveBeanForAnnotation's job,
// and internal/library isn't ported yet (still a Phase 0 placeholder) — see
// service.go's ComputeScoreDetail. Scoring with bean == nil is
// byte-identical to what score.js itself does whenever no bean is resolved
// (no beanId/coffee match, or an install with an empty library), so every
// shot without a bean-specific target scores exactly like Node today; shots
// that would use a bean's own brewTempC/brewRatio target instead fall back
// to the generic band until the Library phase wires bean resolution in.
func CalcShotScoreDetail(shot Shot, bean *Bean) ScoreDetail {
	if shot == nil {
		return ScoreDetail{}
	}
	ss := extractScoreSeries(shot["datapoints"])

	p := divAll(ss.pressure, 10)
	var pVals []float64
	for _, v := range p {
		if v >= 5 {
			pVals = append(pVals, v)
		}
	}
	if len(pVals) <= 3 {
		return ScoreDetail{}
	}

	var scores []int
	var weights []int
	usedBeanTarget := false

	avgP := avg(pVals)
	var sPressure float64
	switch {
	case avgP >= 7 && avgP <= 9.5:
		sPressure = 100
	case avgP < 7:
		sPressure = math.Max(20, 100-(7-avgP)*22)
	default:
		sPressure = math.Max(20, 100-(avgP-9.5)*28)
	}
	scores = append(scores, jsRound(sPressure))
	weights = append(weights, 25)

	tVals := divAll(ss.temperature, 10)
	if len(tVals) > 5 {
		sd := stddev(tVals)
		var stab float64
		switch {
		case sd <= 0.3:
			stab = 100
		case sd <= 0.7:
			stab = 90
		case sd <= 1.5:
			stab = 72
		case sd <= 3:
			stab = 50
		default:
			stab = math.Max(15, 50-(sd-3)*12)
		}

		avgT := avg(tVals)
		var tgt []float64
		for _, v := range divAll(ss.targetTemperature, 10) {
			if v > 0 {
				tgt = append(tgt, v)
			}
		}
		var acc float64
		accBand := func(dev float64) float64 {
			switch {
			case dev <= 0.5:
				return 100
			case dev <= 1:
				return 90
			case dev <= 2:
				return 75
			case dev <= 4:
				return 50
			default:
				return math.Max(15, 50-(dev-4)*8)
			}
		}
		switch {
		case len(tgt) > 0:
			acc = accBand(math.Abs(avgT - avg(tgt)))
		case bean != nil && bean.BrewTempC != nil && *bean.BrewTempC > 0:
			acc = accBand(math.Abs(avgT - *bean.BrewTempC))
			usedBeanTarget = true
		default:
			var off float64
			switch {
			case avgT >= 90 && avgT <= 96:
				off = 0
			case avgT < 90:
				off = 90 - avgT
			default:
				off = avgT - 96
			}
			if off == 0 {
				acc = 100
			} else {
				acc = math.Max(15, 100-off*10)
			}
		}
		scores = append(scores, jsRound((stab+acc)/2))
		weights = append(weights, 20)
	}

	durationRaw, _ := toFloat(shot["duration"])
	secs := durationRaw / 10
	if secs > 5 {
		var sDur float64
		switch {
		case secs >= 25 && secs <= 35:
			sDur = 100
		case (secs >= 20 && secs < 25) || (secs > 35 && secs <= 42):
			sDur = 82
		case secs > 42 && secs <= 55:
			sDur = 62
		case secs < 20:
			sDur = math.Max(15, 70-(20-secs)*5)
		default:
			sDur = math.Max(15, 62-(secs-55)*3)
		}
		scores = append(scores, jsRound(sDur))
		weights = append(weights, 20)
	}

	ann := toMap(shot["annotation"])
	// ss.weight already replicates JS's `d.shotWeight || d.weight || []`
	// truthiness quirk (see scoreSeries.weight's doc comment).
	wArr := ss.weight
	var finalW float64
	if len(wArr) > 0 {
		finalW = maxOf(divAll(wArr, 10))
	}

	dose, _ := toFloat(ann["dose"])
	if dose > 0 && finalW != 0 {
		r := finalW / dose
		var sRatio float64
		var beanTarget float64
		var hasBeanTarget bool
		if bean != nil {
			beanTarget, hasBeanTarget = parseBrewRatioTarget(bean.BrewRatio)
		}
		if hasBeanTarget {
			dev := math.Abs(r - beanTarget)
			switch {
			case dev <= 0.35:
				sRatio = 100
			case dev <= 0.75:
				sRatio = 75
			default:
				sRatio = math.Max(15, 75-(dev-0.75)*30)
			}
			usedBeanTarget = true
		} else {
			switch {
			case r >= 1.8 && r <= 2.5:
				sRatio = 100
			case (r >= 1.5 && r < 1.8) || (r > 2.5 && r <= 3.2):
				sRatio = 75
			case r < 1.5:
				sRatio = math.Max(15, 55-(1.5-r)*40)
			default:
				sRatio = math.Max(15, 60-(r-3.2)*22)
			}
		}
		scores = append(scores, jsRound(sRatio))
		weights = append(weights, 20)
	}

	tds, hasTDS := toFloat(ann["tds"])
	if dose > 0 && hasTDS && tds != 0 && finalW != 0 {
		ey := (finalW * tds) / dose
		var sEY float64
		switch {
		case ey >= 18 && ey <= 22:
			sEY = 100
		case (ey >= 16 && ey < 18) || (ey > 22 && ey <= 24):
			sEY = 75
		case ey < 16:
			sEY = math.Max(15, 60-(16-ey)*10)
		default:
			sEY = math.Max(15, 60-(ey-24)*10)
		}
		scores = append(scores, jsRound(sEY))
		weights = append(weights, 20)
	}

	times := divAll(ss.timeInShot, 10)
	if detectChanneling(times, p) {
		scores = append(scores, 20)
	} else {
		scores = append(scores, 100)
	}
	weights = append(weights, 15)

	totalWeight := 0
	for _, w := range weights {
		totalWeight += w
	}
	if totalWeight == 0 {
		return ScoreDetail{}
	}
	var weighted float64
	for i, s := range scores {
		weighted += float64(s * weights[i])
	}
	score := jsRound(weighted / float64(totalWeight))
	return ScoreDetail{Score: &score, UsedBeanTarget: usedBeanTarget}
}

// CalcShotScore ports lib/score.js's calcShotScore: the score-only wrapper
// every non-detail caller uses.
func CalcShotScore(shot Shot, bean *Bean) *int {
	return CalcShotScoreDetail(shot, bean).Score
}
