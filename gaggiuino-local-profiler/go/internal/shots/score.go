package shots

import (
	"math"
	"regexp"
	"strconv"
)

// This file computes the canonical shot score (0-100): the weights (pressure
// 25, temp stability+accuracy 20, duration 20, brew ratio 20, extraction yield
// 20, channeling 15), thresholds and rounding are the agreed scoring
// definition, shared with the frontend.

// scoreVersion tags every shot_score_cache fingerprint (see pageColumns in
// paging.go), so changing it invalidates every cached score at once. Bump it
// (v3 -> v4, ...) in the same change whenever the score a shot gets can
// change for the same inputs: weights, thresholds, rounding, what counts as
// scoreable. Otherwise GET /api/shots and everything else reading the cache
// keeps serving old scores while the live shot detail shows new ones (#1718).
// TestScoreVersionPinsParityFixture fails when test/fixtures/score-parity.json's
// expected scores change without a bump. It is spliced into SQL as a
// literal, so it must stay a plain [a-z0-9] tag.
const scoreVersion = "v3"

// Bean is the subset of a library bean's fields the scorer reads
// (brewTempC/brewRatio) to replace the generic fixed-band targets with the
// bean's own recommendation (#450). library.ScoreBean resolves a shot's
// annotation to a Bean — see ComputeScoreDetail's doc comment. A nil *Bean
// means no bean was passed at all: generic bands only.
type Bean struct {
	// BrewTempC is nil when the bean has no target temperature set — only a
	// positive number counts as a target.
	BrewTempC *float64
	// BrewRatio is the bean form's own "1:X" convention — empty string means
	// "no target ratio set".
	BrewRatio string
}

// PressureNote values explain the pressure part when it was not scored
// against the fixed >=5-bar band. See ScoreDetail.PressureNote (#1538).
const (
	// PressureNoteProfile: the shot never reached 5 bar, so its pressure was
	// scored against its own targetPressure curve over the samples that fall
	// in a PRESSURE-type phase.
	PressureNoteProfile = "profile"
	// PressureNoteOmitted: the shot never reached 5 bar and its profile has
	// no PRESSURE phase to measure against, so the pressure part was left
	// out and the remaining weights redistribute.
	PressureNoteOmitted = "omitted"
)

// ScoreDetail is the score plus whether a bean target was used. Score is nil
// when there are not enough datapoints to score at all.
type ScoreDetail struct {
	Score          *int
	UsedBeanTarget bool
	// Components is the per-part breakdown behind Score, in the same order
	// the parts are combined. It is nil whenever Score is nil.
	Components []ScoreComponent
	// PressureNote is "" for the common case (a shot that reaches 5 bar and
	// is scored against the fixed band). It is PressureNoteProfile when the
	// pressure part was scored against the shot's own targetPressure, or
	// PressureNoteOmitted when the part was left out — the sub-5-bar paths
	// #1538 added. It lets the shot detail and explain_score say why the
	// pressure part looks the way it does instead of hard-coding one reason.
	PressureNote string
}

// ScoreComponent is one weighted part of CalcShotScoreDetail's score.
type ScoreComponent struct {
	// Name identifies the part: "pressure", "temperature", "duration",
	// "ratio", "extraction_yield" or "channeling".
	Name string
	// Score is 0..100, exactly the value appended to scores.
	Score int
	// Weight is exactly the value appended to weights.
	Weight int
	// Inputs holds the measured values and targets this part was scored on.
	Inputs map[string]float64
	// Target is "profile", "bean" or "generic" — which target band was used.
	Target string
}

// jsRound rounds half-up (towards +Infinity) as math.Floor(x+0.5), not Go's
// math.Round (half away from zero). The two differ on negative .5 values,
// which the score math never produces.
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

// stddev returns the population standard deviation of vals.
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

// detectChanneling reports whether the pressure curve shows channeling. times
// may be shorter than pressures (a missing time is treated as "skip this
// sample" — see the len(times) guard below).
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

// CalcShotScoreDetail scores a shot, operating on the Shot map hydrateRow
// produces (a shot's "datapoints"/"duration"/"annotation" fields).
//
// bean is the shot's resolved library bean target (#450), or nil when none
// resolves — see service.go's ComputeScoreDetail and library.ScoreBean.
// bean == nil yields the generic bands, used whenever no bean is resolved (no
// beanId/coffee match, or an install with an empty library). A non-nil bean
// replaces the generic temperature/ratio targets with its own
// brewTempC/brewRatio recommendations.
func CalcShotScoreDetail(shot Shot, bean *Bean) ScoreDetail {
	if shot == nil {
		return ScoreDetail{}
	}
	ss := extractScoreSeries(shot["datapoints"])

	p := divAll(ss.pressure, 10)
	var pVals []float64
	nonzero := 0
	for _, v := range p {
		if v > 0 {
			nonzero++
		}
		if v >= 5 {
			pVals = append(pVals, v)
		}
	}
	// #1538: "not enough data" means there is no pressure curve at all, not
	// "the curve never reached 5 bar". A shot with >=4 recorded samples that
	// stays below 5 bar (a flat lever profile, a choked grind) is scored — its
	// pressure part against the profile's own target when it has one, or left
	// out when it doesn't. Any shot with >=4 samples at/above 5 bar takes the
	// unchanged fixed-band path below, byte-for-byte as before #1538.
	if nonzero < 4 {
		return ScoreDetail{}
	}

	var scores []int
	var weights []int
	var components []ScoreComponent
	var pressureNote string
	usedBeanTarget := false

	if len(pVals) > 3 {
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
		pressureScore := jsRound(sPressure)
		scores = append(scores, pressureScore)
		weights = append(weights, 25)
		components = append(components, ScoreComponent{
			Name:   "pressure",
			Score:  pressureScore,
			Weight: 25,
			Inputs: map[string]float64{"avg_pressure_bar": avgP},
			Target: "generic",
		})
	} else if mae, samples, ok := profilePressureMAE(shot, p); ok {
		// A sub-5-bar shot whose profile has a PRESSURE phase: score how
		// closely it tracked its own target instead of the unreachable band.
		pressureScore := jsRound(profilePressureScore(mae))
		scores = append(scores, pressureScore)
		weights = append(weights, 25)
		components = append(components, ScoreComponent{
			Name:   "pressure",
			Score:  pressureScore,
			Weight: 25,
			Inputs: map[string]float64{"pressure_mae_bar": mae, "samples": float64(samples)},
			Target: "profile",
		})
		pressureNote = PressureNoteProfile
	} else {
		// Sub-5-bar shot with no pressure target to compare against (no
		// embedded phases, or only FLOW phases whose targetPressure is a
		// limit): leave the part out; the other weights redistribute.
		pressureNote = PressureNoteOmitted
	}

	// #1688: a failed thermocouple read is stored as exactly 0 (there is no
	// per-sample validity flag), so an isolated dropout would otherwise swing
	// stddev and the mean by tens of degrees. A brew path cannot change by
	// 90 C in one sample interval, so drop exact zeros before scoring. With
	// fewer than 6 valid samples left, the temperature part is left out (the
	// same > 5 gate, now applied to the cleaned series).
	var tVals []float64
	for _, v := range divAll(ss.temperature, 10) {
		if v != 0 {
			tVals = append(tVals, v)
		}
	}
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
		targetTemp := 0.0
		hasTargetTemp := false
		tempTarget := "generic"
		switch {
		case len(tgt) > 0:
			targetTemp = avg(tgt)
			hasTargetTemp = true
			tempTarget = "profile"
			acc = accBand(math.Abs(avgT - targetTemp))
		case bean != nil && bean.BrewTempC != nil && *bean.BrewTempC > 0:
			targetTemp = *bean.BrewTempC
			hasTargetTemp = true
			tempTarget = "bean"
			acc = accBand(math.Abs(avgT - targetTemp))
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
		temperatureScore := jsRound((stab + acc) / 2)
		scores = append(scores, temperatureScore)
		weights = append(weights, 20)
		tempInputs := map[string]float64{
			"stddev_c":        sd,
			"avg_temp_c":      avgT,
			"stability_score": stab,
			"accuracy_score":  acc,
		}
		if hasTargetTemp {
			tempInputs["target_temp_c"] = targetTemp
		}
		components = append(components, ScoreComponent{
			Name:   "temperature",
			Score:  temperatureScore,
			Weight: 20,
			Inputs: tempInputs,
			Target: tempTarget,
		})
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
		durationScore := jsRound(sDur)
		scores = append(scores, durationScore)
		weights = append(weights, 20)
		components = append(components, ScoreComponent{
			Name:   "duration",
			Score:  durationScore,
			Weight: 20,
			Inputs: map[string]float64{"seconds": secs},
			Target: "generic",
		})
	}

	ann := toMap(shot["annotation"])
	// ss.weight already applies the `d.shotWeight || d.weight || []`
	// truthiness rule (see scoreSeries.weight's doc comment).
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
		ratioTarget := "generic"
		if hasBeanTarget {
			ratioTarget = "bean"
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
		ratioScore := jsRound(sRatio)
		scores = append(scores, ratioScore)
		weights = append(weights, 20)
		ratioInputs := map[string]float64{
			"ratio":   r,
			"dose_g":  dose,
			"yield_g": finalW,
		}
		if hasBeanTarget {
			ratioInputs["target_ratio"] = beanTarget
		}
		components = append(components, ScoreComponent{
			Name:   "ratio",
			Score:  ratioScore,
			Weight: 20,
			Inputs: ratioInputs,
			Target: ratioTarget,
		})
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
		eyScore := jsRound(sEY)
		scores = append(scores, eyScore)
		weights = append(weights, 20)
		components = append(components, ScoreComponent{
			Name:   "extraction_yield",
			Score:  eyScore,
			Weight: 20,
			Inputs: map[string]float64{
				"extraction_yield_pct": ey,
				"tds_pct":              tds,
			},
			Target: "generic",
		})
	}

	times := divAll(ss.timeInShot, 10)
	channelingScore := 100
	detectedValue := 0.0
	if detectChanneling(times, p) {
		channelingScore = 20
		detectedValue = 1
	}
	scores = append(scores, channelingScore)
	weights = append(weights, 15)
	components = append(components, ScoreComponent{
		Name:   "channeling",
		Score:  channelingScore,
		Weight: 15,
		Inputs: map[string]float64{"detected": detectedValue},
		Target: "generic",
	})

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
	return ScoreDetail{
		Score:          &score,
		UsedBeanTarget: usedBeanTarget,
		Components:     components,
		PressureNote:   pressureNote,
	}
}
