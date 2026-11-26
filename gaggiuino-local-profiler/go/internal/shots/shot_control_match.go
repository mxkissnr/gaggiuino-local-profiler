package shots

// #2221: a Gaggiuino shot recorded without a phaseIndex series still carries
// the target series the machine drove. matchProfilePhases rebuilds the phase
// index per sample by aligning those targets to the embedded profile's phases
// in order, so each phase keeps the control type its profile gave it.

import "math"

// Series units: pressure, flow, weight and water x10 (bar, ml/s, g, ml),
// time in deciseconds. Profile values are converted to them.
const (
	// matchTol is how far a recorded target may sit from the modelled one
	// before it costs anything (the series are rounded to whole units).
	matchTol = 1.5
	// matchScale is the distance past matchTol that costs one full sample.
	matchScale = 5.0
	// matchRampTol is the share of a ramp's span a sample on the ramp may
	// be off, for the phase's unknown exact start time and start value.
	matchRampTol = 0.15
	// matchEndMiss is the cost of ending a phase where none of its stop
	// conditions fits.
	matchEndMiss = 3.0
	// matchLooseEnd is the cost of ending a phase where a stop condition
	// fits only within its slack, so the best-fitting switch wins a tie.
	matchLooseEnd = 0.3
	// matchSkipMiss is the cost of skipping a phase that is neither marked
	// skip nor stopped at once.
	matchSkipMiss = 4.0
	// matchMaxMean is the mean cost per sample above which the alignment
	// counts as inconsistent and the caller falls back.
	matchMaxMean = 0.25
	// matchMaxWork bounds phases x samples x samples, the alignment's
	// work; a larger shot falls back instead of stalling the caller.
	matchMaxWork = 20_000_000
)

// matchPhase is one profile phase in series units.
type matchPhase struct {
	flow        bool
	skip        bool
	instant     bool
	curve       string
	start       float64 // <= 0: the target starts from the shot's state
	end         float64
	rampDs      float64
	restriction float64
	stops       []matchStop
}

// matchStop is one stop condition of a phase in series units.
type matchStop struct {
	kind  int
	value float64
}

// Stop condition kinds, indexing matchStopKeys and matchSlack.
const (
	stopKindTime = iota
	stopKindPressureAbove
	stopKindPressureBelow
	stopKindFlowAbove
	stopKindFlowBelow
	stopKindWeight
	stopKindWater
)

// matchStopKeys are the profile's stopConditions keys per kind.
var matchStopKeys = [...]string{"time", "pressureAbove", "pressureBelow", "flowAbove", "flowBelow", "weight", "waterPumpedInPhase"}

// matchSlack is how far the recorded series lag a stop per kind, in series
// units, measured on the demo shots that carry phaseIndex: the first sample
// of the next phase may still be up to early short of the condition, the
// last sample of the phase at most late past it, and the switch most often
// sits where the margin crosses shift.
var matchSlack = [...]struct{ early, late, shift float64 }{
	stopKindTime:          {1.5, 1.5, 0.5},
	stopKindPressureAbove: {3, 1, 0},
	stopKindPressureBelow: {3, 1, 0},
	stopKindFlowAbove:     {3, 1, 0},
	stopKindFlowBelow:     {3, 1, 0},
	stopKindWeight:        {20, 5, 0},
	stopKindWater:         {2, 5, 4},
}

// phaseMatcher holds the profile phases and the shot's samples that have a
// time and both target values.
type phaseMatcher struct {
	phases                []matchPhase
	t, tp, tf, p, f, w, v []float64
}

// matchProfilePhases returns a phaseIndex-shaped series (one profile phase
// index per timeInShot sample, NaN where a sample has no target values) for
// a Gaggiuino shot without phaseIndex, or nil when the profile cannot be
// modelled or no consistent alignment exists.
func matchProfilePhases(shot Shot, profilePhases []any, series map[string][]float64) []float64 {
	if shot["machineType"] == "gaggimate" || len(profilePhases) == 0 {
		return nil
	}
	phases, ok := matchPhases(profilePhases)
	if !ok {
		return nil
	}
	timeInShot := series["timeInShot"]
	m := phaseMatcher{phases: phases}
	var idx []int
	for i, t := range timeInShot {
		tp, tf := at(series["targetPressure"], i), at(series["targetPumpFlow"], i)
		if math.IsNaN(t) || math.IsNaN(tp) || math.IsNaN(tf) {
			continue
		}
		idx = append(idx, i)
		m.t, m.tp, m.tf = append(m.t, t), append(m.tp, tp), append(m.tf, tf)
		m.p = append(m.p, orZero(at(series["pressure"], i)))
		m.f = append(m.f, orZero(at(series["pumpFlow"], i)))
		m.w = append(m.w, orZero(at(series["shotWeight"], i)))
		m.v = append(m.v, orZero(at(series["waterPumped"], i)))
	}
	if len(idx) < 2 || len(phases)*len(idx)*len(idx) > matchMaxWork {
		return nil
	}
	assigned, ok := m.align()
	if !ok {
		return nil
	}
	out := make([]float64, len(timeInShot))
	for i := range out {
		out[i] = math.NaN()
	}
	for n, i := range idx {
		out[i] = float64(assigned[n])
	}
	return out
}

func orZero(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// matchPhases converts the profile phases; false when a phase's type is not
// FLOW or PRESSURE or no phase can run.
func matchPhases(profilePhases []any) ([]matchPhase, bool) {
	out := make([]matchPhase, len(profilePhases))
	runnable := false
	for i, p := range profilePhases {
		pm := toMap(p)
		control := controlOfType(pm["type"])
		if control == controlUnknown {
			return nil, false
		}
		target := toMap(pm["target"])
		curve, _ := target["curve"].(string)
		ph := matchPhase{
			flow:        control == controlFlow,
			skip:        pm["skip"] == true,
			curve:       curve,
			start:       10 * numberOr0(target["start"]),
			end:         10 * numberOr0(target["end"]),
			rampDs:      numberOr0(target["time"]) / 100,
			restriction: 10 * numberOr0(pm["restriction"]),
			stops:       matchStopsOf(toMap(pm["stopConditions"])),
		}
		ph.instant = curve == "INSTANT" || curve == "" || ph.rampDs <= 0
		if !ph.skip {
			runnable = true
		}
		out[i] = ph
	}
	return out, runnable
}

func numberOr0(v any) float64 {
	if f, ok := toFloat(v); ok {
		return f
	}
	return 0
}

// matchStopsOf converts a phase's set (positive) stop conditions: time from
// ms to ds, every other value x10.
func matchStopsOf(conds map[string]any) []matchStop {
	var out []matchStop
	for kind, key := range matchStopKeys {
		f, ok := toFloat(conds[key])
		if !ok || f <= 0 {
			continue
		}
		if kind == stopKindTime {
			f /= 100
		} else {
			f *= 10
		}
		out = append(out, matchStop{kind: kind, value: f})
	}
	return out
}

// phaseStart is the phase's start time in ds: the shot start for the first
// sample, else halfway between the samples around the switch.
func (m *phaseMatcher) phaseStart(a int) float64 {
	if a == 0 {
		return 0
	}
	return (m.t[a-1] + m.t[a]) / 2
}

// waterAtStart is the water pumped when a phase that starts at sample a began.
func (m *phaseMatcher) waterAtStart(a int) float64 {
	if a == 0 {
		return 0
	}
	return m.v[a-1]
}

// expected returns the modelled controlled target and limit of phase k,
// started at sample a, at sample i, and the tolerance for the controlled one.
func (m *phaseMatcher) expected(k, a, i int) (ctl, limit, tol float64) {
	ph := m.phases[k]
	if ph.instant {
		return ph.end, ph.restriction, matchTol
	}
	start := ph.start
	switch {
	case start > 0:
	case ph.flow && a == 0:
		// The pump flow reading spikes on the first sample; the pump
		// started from standstill.
		start = 0
	case ph.flow:
		start = m.f[a-1]
	default:
		start = m.p[max(a-1, 0)]
	}
	pct := (m.t[i] - m.phaseStart(a)) / ph.rampDs
	pct = math.Max(0, math.Min(1, pct))
	tol = matchTol
	if pct < 1 {
		tol += matchRampTol * math.Abs(ph.end-start)
	}
	return start + (ph.end-start)*curveShare(ph.curve, pct), ph.restriction, tol
}

// curveShare is the share of a ramp done at pct (0..1), after Gaggiuino's
// transition curves.
func curveShare(curve string, pct float64) float64 {
	switch curve {
	case "EASE_IN":
		return math.Pow(pct, 1.675)
	case "EASE_OUT":
		return 1 - math.Pow(1-pct, 1.675)
	case "EASE_IN_OUT":
		return 0.5 * (math.Sin((pct-0.5)*math.Pi) + 1)
	}
	return pct
}

// sampleCost is how badly sample i fits phase k started at sample a: 0 when
// both recorded targets sit within tolerance, up to 2 when both are off.
func (m *phaseMatcher) sampleCost(k, a, i int) float64 {
	ctl, limit, tol := m.expected(k, a, i)
	recCtl, recLimit := m.tp[i], m.tf[i]
	if m.phases[k].flow {
		recCtl, recLimit = m.tf[i], m.tp[i]
	}
	return miss(math.Abs(recCtl-ctl), tol) + miss(math.Abs(recLimit-limit), matchTol)
}

func miss(d, tol float64) float64 {
	return math.Min(1, math.Max(0, d-tol)/matchScale)
}

// stopMargin is how far sample i is past stop condition c of a phase that
// started at sample a, in series units; >= 0 means the condition holds.
func (m *phaseMatcher) stopMargin(c matchStop, a, i int) float64 {
	switch c.kind {
	case stopKindTime:
		return m.t[i] - m.phaseStart(a) - c.value
	case stopKindPressureAbove:
		return m.p[i] - c.value
	case stopKindPressureBelow:
		return c.value - m.p[i]
	case stopKindFlowAbove:
		return m.f[i] - c.value
	case stopKindFlowBelow:
		return c.value - m.f[i]
	case stopKindWeight:
		return m.w[i] - c.value
	}
	return m.v[i] - m.waterAtStart(a) - c.value
}

// endCost is the cost of phase k (started at sample a) switching to the
// next phase between samples j and j+1: nothing where one of its stop
// conditions crosses its shift there, matchLooseEnd where one fits within
// its slack, matchEndMiss where none fits.
func (m *phaseMatcher) endCost(k, a, j int) float64 {
	cost := matchEndMiss
	for _, c := range m.phases[k].stops {
		slack := matchSlack[c.kind]
		before, after := m.stopMargin(c, a, j), m.stopMargin(c, a, j+1)
		switch {
		case before < slack.shift && after >= slack.shift:
			return 0
		case after >= -slack.early && before <= slack.late:
			cost = matchLooseEnd
		}
	}
	return cost
}

// stopPassed reports whether phase k (started at sample a) was already past
// one of its stop conditions at sample i, so sample i+1 cannot belong to it.
func (m *phaseMatcher) stopPassed(k, a, i int) bool {
	for _, c := range m.phases[k].stops {
		if m.stopMargin(c, a, i) > matchSlack[c.kind].late {
			return true
		}
	}
	return false
}

// skipCost is the cost of phase k running no sample, switching to the next
// phase right before sample a: nothing for a phase marked skip, little when
// a pressure, flow or weight stop already held, else matchSkipMiss.
func (m *phaseMatcher) skipCost(k, a int) float64 {
	ph := m.phases[k]
	if ph.skip {
		return 0
	}
	for _, c := range ph.stops {
		if c.kind != stopKindTime && c.kind != stopKindWater && m.stopMargin(c, a, a) >= -matchSlack[c.kind].early {
			return 0.5
		}
	}
	return matchSkipMiss
}

// align assigns every sample a profile phase index, phases in profile order,
// by dynamic programming over (phase, first sample, last sample). It reports
// false when the cheapest alignment costs more than matchMaxMean per sample.
func (m *phaseMatcher) align() ([]int, bool) {
	n, kn := len(m.t), len(m.phases)
	inf := math.Inf(1)
	grid := func() [][]float64 {
		g := make([][]float64, kn)
		for k := range g {
			g[k] = make([]float64, n)
			for i := range g[k] {
				g[k][i] = inf
			}
		}
		return g
	}
	ints := func() [][]int {
		g := make([][]int, kn)
		for k := range g {
			g[k] = make([]int, n)
		}
		return g
	}
	// startCost[k][a]: cheapest cost of samples before a with phase k
	// starting at sample a; startFrom names the phase that ended at a-1
	// (-1: none, the shot starts with phase k).
	startCost, startFrom := grid(), ints()
	// endCost[k][j]: cheapest cost of samples 0..j with phase k ending at j
	// and the shot going on; endFrom is that phase's first sample.
	endCost, endFrom := grid(), ints()

	acc := 0.0
	for k := 0; k < kn; k++ {
		startCost[k][0], startFrom[k][0] = acc, -1
		acc += m.skipCost(k, 0)
	}
	best, bestK, bestA := inf, -1, -1
	for k := 0; k < kn; k++ {
		if !m.phases[k].skip {
			for a := 0; a < n; a++ {
				cost := startCost[k][a]
				if math.IsInf(cost, 1) {
					continue
				}
				for j := a; j < n && cost < best; j++ {
					cost += m.sampleCost(k, a, j)
					if j > a && m.stopPassed(k, a, j-1) {
						cost++
					}
					if j == n-1 {
						if cost < best {
							best, bestK, bestA = cost, k, a
						}
						break
					}
					end := cost + m.endCost(k, a, j)
					if end < endCost[k][j] {
						endCost[k][j], endFrom[k][j] = end, a
					}
				}
			}
		}
		for j := 0; j+1 < n; j++ {
			cost := endCost[k][j]
			for k2 := k + 1; k2 < kn && !math.IsInf(cost, 1); k2++ {
				if cost < startCost[k2][j+1] {
					startCost[k2][j+1], startFrom[k2][j+1] = cost, k
				}
				cost += m.skipCost(k2, j+1)
			}
		}
	}
	if bestK < 0 || best/float64(n) > matchMaxMean {
		return nil, false
	}
	out := make([]int, n)
	k, a, last := bestK, bestA, n-1
	for {
		for i := a; i <= last; i++ {
			out[i] = k
		}
		prev := startFrom[k][a]
		if prev < 0 {
			break
		}
		k, last = prev, a-1
		a = endFrom[k][last]
	}
	return out, true
}
