package shots

// This file holds the shot-detail metrics math CalcShotScoreDetail (score.go)
// does not already expose: getShotData()+calcBrewRatio() (dose->yield->ratio,
// EY) and detectPhases() (the preinfusion/extraction split). The history-aware
// comparative grind advice lives separately in comparative.go. Deliberately
// not implemented here: any bean-library-aware branch (#450, the same
// internal/library boundary CalcShotScoreDetail's own doc comment already
// describes) — out of scope for a single shot's detail view.

// ShotMetrics is the shot-detail page's derived recipe/duration/channeling
// figures — a plain data struct (not pre-formatted strings), same division
// of labor as ScoreDetail: this package computes the numbers, the
// caller decides display formatting/units.
//
// Yield/Ratio/EY reuse CalcShotScoreDetail's own "final weight = max of the
// weight series" convention (not calcBrewRatio's "last sample" convention)
// so a shot's Metrics-Grid ratio always matches the ratio
// CalcShotScoreDetail itself scored against.
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

// avgActive returns the mean of every value above threshold, falling back to
// the series' last value when none qualify — always a number for a non-empty
// vals.
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

// detectPhases splits (times, pressures) into preinfusion/extraction, found as
// the first sample at least 1s in where pressure crosses 3.5 bar.
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

// ComputeShotMetrics derives the dose/yield/ratio/EY/duration/phase metrics
// from shot's own datapoints/annotation/duration — the same raw fields
// CalcShotScoreDetail (score.go) already reads, so a shot with too little data
// to score (CalcShotScoreDetail returning a nil Score) can still get partial
// metrics here (e.g. duration alone) — every field is independently gated by
// its own Has* flag.
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

	// wArr replicates the `d.shotWeight || d.weight || []` truthiness quirk
	// — see CalcShotScoreDetail's own comment on the identical pattern in
	// score.go.
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
