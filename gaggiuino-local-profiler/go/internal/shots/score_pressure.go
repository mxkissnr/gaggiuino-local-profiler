package shots

import (
	stdjson "encoding/json"
	"math"

	json "github.com/goccy/go-json"
)

// profilePressureScore maps the mean absolute error, in bar, between a shot's
// recorded pressure and its own targetPressure to a 0-100 part score (#1538):
// within 0.5 bar is full marks, then -20 per further bar, floored at 20. The
// band boundaries are a first cut to be calibrated against the #1505 scoring
// evaluation once it has more profile-relative samples.
func profilePressureScore(mae float64) float64 {
	if mae <= 0.5 {
		return 100
	}
	return math.Max(20, 100-20*(mae-0.5))
}

// profilePressureMAE is the mean absolute error, in bar, between a shot's
// recorded pressure (already /10) and its own targetPressure curve, over the
// samples that fall in a PRESSURE-type phase. A FLOW phase's targetPressure is
// a ceiling the pump respects, not a target the shot should hit, so those
// samples are deliberately excluded. ok is false when there is no usable
// phase metadata — no embedded profile, no phaseIndex/targetPressure series,
// or no PRESSURE phase at all (GaggiMate shots, FLOW-only lever profiles) —
// and the caller then leaves the pressure part out of the score.
func profilePressureMAE(shot Shot, pressureBar []float64) (mae float64, samples int, ok bool) {
	phases := pressurePhaseIndexes(shot["profile"])
	if len(phases) == 0 {
		return 0, 0, false
	}
	target, phaseIdx, ok := pressureTargetSeries(shot["datapoints"])
	if !ok {
		return 0, 0, false
	}
	n := len(pressureBar)
	if len(target) < n {
		n = len(target)
	}
	if len(phaseIdx) < n {
		n = len(phaseIdx)
	}
	var sum float64
	for i := 0; i < n; i++ {
		if !phases[int(phaseIdx[i])] || target[i] <= 0 {
			continue
		}
		d := pressureBar[i] - target[i]/10
		if d < 0 {
			d = -d
		}
		sum += d
		samples++
	}
	if samples == 0 {
		return 0, 0, false
	}
	return sum / float64(samples), samples, true
}

// pressurePhaseIndexes returns the set of phase indexes whose embedded profile
// phase is a PRESSURE phase. profile is hydrateRow's decoded "profile" value (a
// map[string]any — only datapoints stays raw). nil when the profile, its
// phases, or any PRESSURE phase is absent.
func pressurePhaseIndexes(profile any) map[int]bool {
	phases, _ := toMap(profile)["phases"].([]any)
	if len(phases) == 0 {
		return nil
	}
	out := make(map[int]bool, len(phases))
	for i, p := range phases {
		if toMap(p)["type"] == "PRESSURE" {
			out[i] = true
		}
	}
	return out
}

// pressureTargetSeries pulls the targetPressure and phaseIndex arrays out of a
// shot's "datapoints" value in either shape (hydrateRow's json.RawMessage or a
// hand-built map[string]any), mirroring extractScoreSeries. ok is false when
// either series is missing or empty — the sub-5-bar pressure path needs both.
func pressureTargetSeries(v any) (target, phaseIdx []float64, ok bool) {
	switch t := v.(type) {
	case map[string]any:
		target = floatSlice(t["targetPressure"])
		phaseIdx = floatSlice(t["phaseIndex"])
	case stdjson.RawMessage:
		target, phaseIdx = pressureTargetFromRaw(t)
	case []byte:
		target, phaseIdx = pressureTargetFromRaw(t)
	}
	return target, phaseIdx, len(target) > 0 && len(phaseIdx) > 0
}

func pressureTargetFromRaw(raw []byte) (target, phaseIdx []float64) {
	if isJSONNull(raw) {
		return nil, nil
	}
	var m map[string]stdjson.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil
	}
	return decodeFloatArray(m["targetPressure"]), decodeFloatArray(m["phaseIndex"])
}
