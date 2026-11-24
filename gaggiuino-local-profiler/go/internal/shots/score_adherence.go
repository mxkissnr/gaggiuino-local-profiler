package shots

// #2186: the experimental score model "adherence". It is the classic score
// plus one extra part that measures how closely the shot tracked its profile's
// own target pressure inside its PRESSURE phases. It ports
// adherencePressureMae from the offline #1505 harness (score-research, not in
// this repo) literally, so its numbers match the harness's.
//
// Dev-channel only: init() registers classic alone, and cmd/server calls
// RegisterDevScoreModels only when GLP_DEV_BUILD is set. A stable build never
// registers or shows this model.

import (
	stdjson "encoding/json"
	"math"

	json "github.com/goccy/go-json"
)

// AdherenceScoreModel is the id of the experimental model that adds a
// pressure adherence part to classic (#2186). Dev builds only.
const AdherenceScoreModel = "adherence"

// PressureAdherenceComponent is the ScoreComponent name of that part.
const PressureAdherenceComponent = "pressure_adherence"

const (
	// adherenceWeight is the part's weight in the combined weighted average.
	adherenceWeight = 15
	// adherenceZeroAtBar is the mean absolute error, in bar, at which the part
	// scores 0. 0 bar scores 100 and the mapping is linear in between.
	adherenceZeroAtBar = 3.0
	// adherenceSettleS is the transition window skipped at the start of every
	// phase after phase 0, in seconds.
	adherenceSettleS = 1.5
)

// adherencePressureMAE is the harness's adherencePressureMae: the mean absolute
// error, in bar, between the shot's recorded pressure and its targetPressure
// over the samples in a PRESSURE-type phase, skipping the first 1.5 s of every
// phase after phase 0. Unlike profilePressureMAE it drops no sample for a
// zero target and keeps the series index-aligned, so a missing element becomes
// NaN instead of shifting the rest of the series.
func adherencePressureMAE(shot Shot) (mae float64, samples int, ok bool) {
	phases := pressurePhaseIndexes(shot["profile"])
	if len(phases) == 0 {
		return 0, 0, false
	}
	series := alignedSeries(shot["datapoints"], "timeInShot", "pressure", "targetPressure", "phaseIndex")
	timeInShot, pressure := series["timeInShot"], series["pressure"]
	targetPressure, phaseIndex := series["targetPressure"], series["phaseIndex"]
	if len(timeInShot) == 0 || len(phaseIndex) == 0 {
		return 0, 0, false
	}

	// The first sample of every phase index marks when that phase started.
	start := make(map[int]float64, len(phases))
	for i, pi := range phaseIndex {
		if idx, valid := wholePhaseIndex(pi); valid {
			if _, seen := start[idx]; !seen {
				start[idx] = at(timeInShot, i) / 10
			}
		}
	}

	var sum float64
	for i := 0; i < len(timeInShot); i++ {
		idx, valid := wholePhaseIndex(at(phaseIndex, i))
		if !valid || !phases[idx] {
			continue
		}
		t := at(timeInShot, i) / 10
		// NaN comparison is false, so a sample without a time is not skipped.
		if idx > 0 && t-start[idx] < adherenceSettleS {
			continue
		}
		p, tp := at(pressure, i), at(targetPressure, i)
		if math.IsNaN(p) || math.IsNaN(tp) {
			continue
		}
		sum += math.Abs(p/10 - tp/10)
		samples++
	}
	if samples == 0 {
		return 0, 0, false
	}
	return sum / float64(samples), samples, true
}

// wholePhaseIndex reads a phase index: a non-negative whole number, NaN and
// negative values rejected. The upper bound keeps the float-to-int conversion
// defined for absurd input.
func wholePhaseIndex(pi float64) (int, bool) {
	if pi < 0 || pi != math.Trunc(pi) || pi > math.MaxInt32 {
		return 0, false
	}
	return int(pi), true
}

// at reads one index of an index-aligned series; an index past the end reads
// as NaN, exactly like a missing element.
func at(s []float64, i int) float64 {
	if i < 0 || i >= len(s) {
		return math.NaN()
	}
	return s[i]
}

// alignedSeries pulls the named series out of a shot's "datapoints" value in
// either shape, keeping every element at its own index: a null or non-number
// element becomes NaN instead of being dropped (unlike decodeFloatArray and
// floatSlice). A missing, null or undecodable series is a nil slice.
func alignedSeries(v any, keys ...string) map[string][]float64 {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string][]float64, len(keys))
		for _, k := range keys {
			arr, _ := t[k].([]any)
			if arr == nil {
				out[k] = nil
				continue
			}
			s := make([]float64, len(arr))
			for i, x := range arr {
				if f, ok := x.(float64); ok {
					s[i] = f
				} else {
					s[i] = math.NaN()
				}
			}
			out[k] = s
		}
		return out
	case stdjson.RawMessage:
		return alignedSeriesFromRaw(t, keys)
	case []byte:
		return alignedSeriesFromRaw(t, keys)
	default:
		return map[string][]float64{}
	}
}

func alignedSeriesFromRaw(raw []byte, keys []string) map[string][]float64 {
	out := make(map[string][]float64, len(keys))
	if isJSONNull(raw) {
		return out
	}
	var m map[string]stdjson.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return out
	}
	for _, k := range keys {
		r := m[k]
		if isJSONNull(r) {
			out[k] = nil
			continue
		}
		var ptrs []*float64
		if err := json.Unmarshal(r, &ptrs); err != nil {
			out[k] = nil
			continue
		}
		s := make([]float64, len(ptrs))
		for i, p := range ptrs {
			if p != nil {
				s[i] = *p
			} else {
				s[i] = math.NaN()
			}
		}
		out[k] = s
	}
	return out
}

// adherencePartScore maps the mean absolute pressure error, in bar, to a
// 0..100 part score: 0 bar scores 100, adherenceZeroAtBar or more scores 0,
// linear in between (1.5 bar scores 50).
func adherencePartScore(mae float64) int {
	return jsRound(math.Max(0, 100-mae*100/adherenceZeroAtBar))
}

// scoreWithAdherence is the adherence model's scorer: classic's ScoreDetail
// with a pressure_adherence part appended and the total recombined over the
// widened weight sum. Without usable target pressure data — or when classic
// cannot score the shot — it returns classic's detail unchanged.
func scoreWithAdherence(shot Shot, targets ScoreTargets) ScoreDetail {
	detail := classicModel().Score(shot, targets)
	if detail.Score == nil {
		return detail
	}
	mae, samples, ok := adherencePressureMAE(shot)
	if !ok {
		return detail
	}
	components := make([]ScoreComponent, 0, len(detail.Components)+1)
	components = append(components, detail.Components...)
	components = append(components, ScoreComponent{
		Name:   PressureAdherenceComponent,
		Score:  adherencePartScore(mae),
		Weight: adherenceWeight,
		Inputs: map[string]float64{"pressure_mae_bar": mae, "samples": float64(samples)},
		Target: "profile",
	})
	total, weighted := 0, 0.0
	for _, c := range components {
		total += c.Weight
		weighted += float64(c.Score * c.Weight)
	}
	score := jsRound(weighted / float64(total))
	detail.Score = &score
	detail.Components = components
	return detail
}

// adherenceModel is the registered model for the adherence id.
func adherenceModel() ScoreModel {
	return ScoreModel{ID: AdherenceScoreModel, Score: scoreWithAdherence}
}

// RegisterDevScoreModels appends the experimental dev-channel models (#2186:
// adherence) after classic. cmd/server calls it only on a dev build, so a
// stable build keeps classic as its only model. Calling it again adds nothing.
// The returned func restores the registry as it was before the call; tests in
// other packages use it with t.Cleanup because the registry is unexported.
func RegisterDevScoreModels() (restore func()) {
	prev := loadScoreModels()
	restore = func() {
		restored := prev
		scoreModels.Store(&restored)
	}
	for _, m := range prev {
		if m.ID == AdherenceScoreModel {
			return restore
		}
	}
	next := make([]ScoreModel, 0, len(prev)+1)
	next = append(next, prev...)
	next = append(next, adherenceModel())
	scoreModels.Store(&next)
	return restore
}
