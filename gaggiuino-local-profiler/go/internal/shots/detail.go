package shots

import "fmt"

// This file ports the shot-detail metrics/advice math CalcShotScoreDetail
// (score.go) doesn't already expose: public-src/views/shots/utils.js's
// getShotData()+calcBrewRatio() (dose->yield->ratio, EY), public-src/
// utils.js's detectPhases() (preinfusion/extraction split), and public-src/
// views/shots/grind.js's calcGrindAdvice() (single-shot dial-in heuristic).
// Deliberately NOT ported: calcComparativeGrindAdvice (needs the full shot
// history, not just this shot) and any bean-library-aware branch (#450,
// same internal/library-not-ported-yet boundary CalcShotScoreDetail's own
// doc comment already describes) — both are out of scope for a single
// shot's own detail view.

// ShotMetrics is the shot-detail page's derived recipe/duration/channeling
// figures — a plain data struct (not pre-formatted strings), same division
// of labor as ScoreDetail: this package computes the numbers, internal/web's
// view layer decides display formatting/units.
//
// Yield/Ratio/EY reuse CalcShotScoreDetail's own "final weight = max of the
// weight series" convention (not calcBrewRatio's "last sample" convention —
// see calcGrindAdvice's own doc comment below for why that distinction is
// deliberately not carried over) so a shot's Metrics-Grid ratio always
// matches the ratio CalcShotScoreDetail itself scored against.
type ShotMetrics struct {
	HasDose bool
	DoseG   float64

	HasYield bool
	YieldG   float64

	HasRatio bool
	Ratio    float64

	HasEY bool
	EY    float64

	DurationSecs float64

	HasPhases       bool
	PreinfusionSecs float64
	ExtractionSecs  float64

	Channeling bool

	HasAvgPressure bool
	AvgPressureBar float64
}

// avgActive ports public-src/utils.js's avgActive(arr, t): the mean of
// every value above threshold, falling back to the series' last value when
// none qualify — never null/zero-value for a non-empty vals, matching the
// JS original's "arr.length -> always a number" guarantee.
func avgActive(vals []float64, threshold float64) (float64, bool) {
	if len(vals) == 0 {
		return 0, false
	}
	var sum float64
	var n int
	for _, v := range vals {
		if v > threshold {
			sum += v
			n++
		}
	}
	if n > 0 {
		return sum / float64(n), true
	}
	return vals[len(vals)-1], true
}

// detectPhases ports public-src/utils.js's detectPhases(times, pressures):
// the preinfusion/extraction split, found as the first sample at least 1s
// in where pressure crosses 3.5 bar.
func detectPhases(times, pressures []float64) (preinfusion, extraction float64, ok bool) {
	if len(times) == 0 || len(pressures) < 5 {
		return 0, 0, false
	}
	const thresh = 3.5
	endIdx := -1
	for i := 0; i < len(pressures); i++ {
		if i >= len(times) {
			continue
		}
		if times[i] >= 1 && pressures[i] >= thresh {
			endIdx = i
			break
		}
	}
	if endIdx <= 0 {
		return 0, 0, false
	}
	preinfusion = times[endIdx]
	if preinfusion < 1.5 {
		return 0, 0, false
	}
	extraction = times[len(times)-1] - preinfusion
	return preinfusion, extraction, true
}

// ComputeShotMetrics ports getShotData()+calcBrewRatio()+detectPhases()
// against shot's own datapoints/annotation/duration — the same raw fields
// CalcShotScoreDetail (score.go) already reads, so a shot with too little
// data to score (CalcShotScoreDetail returning a nil Score) can still get
// partial metrics here (e.g. duration alone) — every field is independently
// gated by its own Has* flag.
func ComputeShotMetrics(shot Shot) ShotMetrics {
	var m ShotMetrics
	if shot == nil {
		return m
	}
	d := DatapointsMap(shot)
	times := divAll(floatSlice(d["timeInShot"]), 10)
	pressures := divAll(floatSlice(d["pressure"]), 10)

	if avgP, ok := avgActive(pressures, 1.5); ok {
		m.AvgPressureBar = avgP
		m.HasAvgPressure = true
	}

	if durationRaw, ok := toFloat(shot["duration"]); ok {
		m.DurationSecs = durationRaw / 10
	}

	if pre, ext, ok := detectPhases(times, pressures); ok {
		m.PreinfusionSecs = pre
		m.ExtractionSecs = ext
		m.HasPhases = true
	}
	m.Channeling = detectChanneling(times, pressures)

	ann := toMap(shot["annotation"])
	if dose, ok := toFloat(ann["dose"]); ok && dose > 0 {
		m.DoseG = dose
		m.HasDose = true
	}

	// wArr replicates JS's `d.shotWeight || d.weight || []` truthiness
	// quirk — see CalcShotScoreDetail's own comment on the identical
	// pattern in score.go.
	var wRaw any
	if v, ok := d["shotWeight"]; ok && v != nil {
		wRaw = v
	} else if v, ok := d["weight"]; ok && v != nil {
		wRaw = v
	}
	if wArr := floatSlice(wRaw); len(wArr) > 0 {
		if finalW := maxOf(divAll(wArr, 10)); finalW > 0 {
			m.YieldG = finalW
			m.HasYield = true
		}
	}

	if m.HasDose && m.HasYield && m.DoseG > 0 {
		m.Ratio = m.YieldG / m.DoseG
		m.HasRatio = true
	}

	if tds, ok := toFloat(ann["tds"]); ok && tds > 0 && m.HasDose && m.HasYield {
		m.EY = (m.YieldG * tds) / m.DoseG
		m.HasEY = true
	}

	return m
}

// GrindAdvice mirrors public-src/views/shots/grind.js's calcGrindAdvice —
// a single-shot dial-in heuristic (duration -> channeling -> brew-ratio
// checks). Icon is a plain glyph, not inline SVG, matching this package's
// existing shots.templ stars()/icon convention (kept as text to avoid CSP
// questions this foundation doesn't need to answer).
//
// Deliberately NOT ported: calcComparativeGrindAdvice (needs the full shot
// history to find "the best-scoring grind setting among comparable
// shots", out of scope for a single Shot value) and calcBrewRatio's
// "last weight sample" ratio definition (this uses ShotMetrics.Ratio's
// max-of-series definition instead — the two are within noise of each
// other for any well-formed weight series, and using one definition
// throughout keeps the Metrics-Grid ratio and this advice's ratio check
// always in agreement, which matters more here than matching the Node
// original's incidental use of two different weight extractions for two
// unrelated features).
type GrindAdvice struct {
	// Type is "finer" | "coarser" | "warning" | "ok".
	Type string
	Icon string
	Text string
}

// ComputeGrindAdvice returns nil exactly when the Node original's
// calcGrindAdvice would (shot.duration < 8s — not enough of a pull to say
// anything).
func ComputeGrindAdvice(shot Shot, m ShotMetrics) *GrindAdvice {
	secs := m.DurationSecs
	if secs < 8 {
		return nil
	}

	d := DatapointsMap(shot)
	times := divAll(floatSlice(d["timeInShot"]), 10)
	pressures := divAll(floatSlice(d["pressure"]), 10)
	if detectChanneling(times, pressures) {
		return &GrindAdvice{Type: "warning", Icon: "⚡", Text: "Channeling detected — check your puck prep"}
	}

	switch {
	case secs < 18:
		return &GrindAdvice{Type: "finer", Icon: "↓", Text: fmt.Sprintf("%.0fs — grind finer", secs)}
	case secs < 23:
		return &GrindAdvice{Type: "finer", Icon: "↓", Text: fmt.Sprintf("%.0fs — grind slightly finer", secs)}
	case secs > 50:
		return &GrindAdvice{Type: "coarser", Icon: "↑", Text: fmt.Sprintf("%.0fs — grind coarser", secs)}
	case secs > 42:
		return &GrindAdvice{Type: "coarser", Icon: "↑", Text: fmt.Sprintf("%.0fs — grind slightly coarser", secs)}
	}

	if m.HasRatio {
		if m.Ratio > 2.3 {
			return &GrindAdvice{Type: "warning", Icon: "⚖", Text: fmt.Sprintf("Ratio 1:%.1f — yield high for the dose", m.Ratio)}
		}
		if m.Ratio < 1.7 {
			return &GrindAdvice{Type: "warning", Icon: "⚖", Text: fmt.Sprintf("Ratio 1:%.1f — yield low for the dose", m.Ratio)}
		}
	}

	text := fmt.Sprintf("Dialed in — %.0fs", secs)
	if m.HasAvgPressure && m.AvgPressureBar > 0 {
		text += fmt.Sprintf(", %.1f bar avg", m.AvgPressureBar)
	}
	return &GrindAdvice{Type: "ok", Icon: "✓", Text: text}
}
