package shots

// #2219: ResolveShotControl reads what a shot's profile controls and what it
// leaves free: how the shot was stopped, the recipe target and, per phase, the
// controlled and the free variable. It is read-only input for profile-relative
// scoring (#1505). No scorer calls it, so classic and adherence are unchanged.

import (
	stdjson "encoding/json"
	"math"

	json "github.com/goccy/go-json"
)

const (
	stopWeight = "weight"
	stopTime   = "time"
	stopWater  = "water"
	stopNone   = "none"

	controlFlow     = "flow"
	controlPressure = "pressure"
	controlUnknown  = "unknown"

	sourceProfile  = "profile"
	sourceInferred = "inferred"
	sourceMatched  = "matched"
	sourceNone     = "none"
)

// gaggiMateExitReasons names GaggiMate's PHASE_EXIT_REASON_* codes
// (shot_log_format.h); 0 (unknown/legacy) has no name.
var gaggiMateExitReasons = map[int]string{
	1: "weight", 2: "pressure", 3: "flow", 4: "water", 5: "time",
	6: "safety_timeout", 7: "manual", 8: "button_released", 9: "ratio",
}

// ShotControl describes what a shot's profile controlled and what it left free.
type ShotControl struct {
	// StopMode is how the shot was stopped: "weight", "time", "water" or "none".
	StopMode string
	// StopTarget is the stop value in g (weight), ml (water) or s (time); nil
	// when unknown, always for a GaggiMate shot (it embeds no profile).
	StopTarget *float64
	// StopFrom says where StopMode was read: "global" (globalStopConditions),
	// "last_phase" (the last phase's stopConditions) or "exit_reason"
	// (GaggiMate finalExitReason); "" when StopMode is "none".
	StopFrom string
	// FreeResult is the result the stop leaves free: "time" for a weight
	// stop, "yield" for a time or water stop, "unknown" otherwise.
	FreeResult string
	// Recipe is profile.recipe; nil when the profile names none.
	Recipe *RecipeTarget
	// Phases lists the phases in shot order. Never nil.
	Phases []PhaseControl
	// Source says where Phases came from: "profile" (the embedded profile's
	// phases), "matched" (the embedded profile's phases, aligned to the
	// target series of a shot without phaseIndex, #2221), "inferred"
	// (control type guessed from the target series) or "none" (no phase data).
	Source string
	// ProfileName is the profile the shot was brewed with: profileName, else
	// profile.name.
	ProfileName string
}

// RecipeTarget is a Gaggiuino profile's recipe: dose and yield in g, ratio.
type RecipeTarget struct {
	DoseG  *float64
	YieldG *float64
	Ratio  *float64
}

// PhaseControl is one phase: what it controlled, what it left free, its
// targets and stop conditions, and when it ran.
type PhaseControl struct {
	// Index is the profile phase index (GaggiMate: the recorded phase number;
	// inferred phases: their position).
	Index int
	// Name is the recorded phase name (GaggiMate only).
	Name string
	// Control is "flow", "pressure" or "unknown".
	Control string
	// Free is the variable the phase leaves free: "pressure" for a flow
	// phase, "flow" for a pressure phase, "unknown" otherwise.
	Free string
	// TargetEnd is the profile phase's target.end (bar or ml/s).
	TargetEnd *float64
	// Restriction is the profile phase's limit on the free variable.
	Restriction *float64
	// StopConditions are the profile phase's non-zero stop conditions as the
	// profile stores them (time in ms).
	StopConditions map[string]float64
	// ExitReason is why a GaggiMate phase ended ("weight", "time", ...).
	ExitReason string
	// StartS and EndS are the first and last sample time of the phase, in s;
	// nil when the shot never ran the phase or has no phase timing.
	StartS *float64
	EndS   *float64
}

// ResolveShotControl resolves a shot's ShotControl. It never fails: missing
// data resolves to "none"/"unknown" values.
func ResolveShotControl(shot Shot) ShotControl {
	profile := toMap(shot["profile"])
	profilePhases, _ := profile["phases"].([]any)
	transitions, finalExit, hasExit := gaggiMatePhaseLog(shot["datapoints"])
	series := alignedSeries(shot["datapoints"], "timeInShot", "targetPumpFlow", "phaseIndex",
		"targetPressure", "pressure", "pumpFlow", "shotWeight", "waterPumped")
	timeInShot, targetPumpFlow, phaseIndex := series["timeInShot"], series["targetPumpFlow"], series["phaseIndex"]

	c := ShotControl{
		Recipe:      recipeTarget(profile),
		Phases:      []PhaseControl{},
		Source:      sourceNone,
		ProfileName: scoreProfileName(shot),
	}
	if hasExit {
		c.StopMode = exitReasonStop(finalExit)
		if c.StopMode != stopNone {
			c.StopFrom = "exit_reason"
		}
	} else {
		c.StopMode, c.StopTarget, c.StopFrom = profileStop(profile, profilePhases)
	}
	c.FreeResult = freeResult(c.StopMode)

	switch {
	case len(transitions) > 0:
		c.Phases, c.Source = gaggiMatePhases(transitions, finalExit, timeInShot, targetPumpFlow), sourceInferred
	case len(profilePhases) > 0 && hasPhaseIndex(phaseIndex):
		c.Phases, c.Source = profilePhaseControls(profilePhases, timeInShot, phaseIndex), sourceProfile
	default:
		if matched := matchProfilePhases(shot, profilePhases, series); matched != nil {
			c.Phases, c.Source = profilePhaseControls(profilePhases, timeInShot, matched), sourceMatched
		} else if inferred := inferredPhases(timeInShot, targetPumpFlow); len(inferred) > 0 {
			c.Phases, c.Source = inferred, sourceInferred
		} else if len(profilePhases) > 0 {
			c.Phases, c.Source = profilePhaseControls(profilePhases, nil, nil), sourceProfile
		}
	}
	return c
}

// profileStop reads a Gaggiuino stop: globalStopConditions first, else the
// last phase's stopConditions (only the last phase can end the shot).
func profileStop(profile map[string]any, phases []any) (mode string, target *float64, from string) {
	if mode, target := stopFrom(toMap(profile["globalStopConditions"]), "waterPumped"); mode != stopNone {
		return mode, target, "global"
	}
	if len(phases) > 0 {
		last := toMap(toMap(phases[len(phases)-1])["stopConditions"])
		if mode, target := stopFrom(last, "waterPumpedInPhase"); mode != stopNone {
			return mode, target, "last_phase"
		}
	}
	return stopNone, nil, ""
}

// stopFrom picks the condition that fixes the shot's result, in the order
// weight, water, time: a weight stop wins over a time cap set next to it.
// Time is converted from ms to s.
func stopFrom(conds map[string]any, waterKey string) (string, *float64) {
	if v := positivePtr(conds["weight"]); v != nil {
		return stopWeight, v
	}
	if v := positivePtr(conds[waterKey]); v != nil {
		return stopWater, v
	}
	if v := positivePtr(conds["time"]); v != nil {
		s := *v / 1000
		return stopTime, &s
	}
	return stopNone, nil
}

func freeResult(mode string) string {
	switch mode {
	case stopWeight:
		return "time"
	case stopTime, stopWater:
		return "yield"
	}
	return "unknown"
}

func recipeTarget(profile map[string]any) *RecipeTarget {
	r := toMap(profile["recipe"])
	out := RecipeTarget{DoseG: positivePtr(r["coffeeIn"]), YieldG: positivePtr(r["coffeeOut"]), Ratio: positivePtr(r["ratio"])}
	if out.DoseG == nil && out.YieldG == nil && out.Ratio == nil {
		return nil
	}
	return &out
}

func controlOfType(t any) string {
	switch t {
	case "FLOW":
		return controlFlow
	case "PRESSURE":
		return controlPressure
	}
	return controlUnknown
}

func freeOf(control string) string {
	switch control {
	case controlFlow:
		return controlPressure
	case controlPressure:
		return controlFlow
	}
	return controlUnknown
}

// profilePhaseControls lists every embedded profile phase in order, timed by
// the phaseIndex series (nil series: no times).
func profilePhaseControls(phases []any, timeInShot, phaseIndex []float64) []PhaseControl {
	out := make([]PhaseControl, len(phases))
	for i, p := range phases {
		pm := toMap(p)
		control := controlOfType(pm["type"])
		out[i] = PhaseControl{
			Index:          i,
			Control:        control,
			Free:           freeOf(control),
			TargetEnd:      numberPtr(toMap(pm["target"])["end"]),
			Restriction:    positivePtr(pm["restriction"]),
			StopConditions: nonZeroConditions(toMap(pm["stopConditions"])),
		}
	}
	for j, pi := range phaseIndex {
		idx, ok := wholePhaseIndex(pi)
		t := at(timeInShot, j)
		if !ok || idx >= len(out) || math.IsNaN(t) {
			continue
		}
		start, end := t/10, t/10
		if out[idx].StartS == nil {
			out[idx].StartS = &start
		}
		out[idx].EndS = &end
	}
	return out
}

func positivePtr(v any) *float64 {
	if f, ok := toFloat(v); ok && f > 0 {
		return &f
	}
	return nil
}

func numberPtr(v any) *float64 {
	if f, ok := toFloat(v); ok {
		return &f
	}
	return nil
}

func nonZeroConditions(m map[string]any) map[string]float64 {
	var out map[string]float64
	for k, v := range m {
		if f, ok := toFloat(v); ok && f != 0 {
			if out == nil {
				out = map[string]float64{}
			}
			out[k] = f
		}
	}
	return out
}

// exitReasonStop maps a GaggiMate finalExitReason to a stop mode; a ratio
// stop is a weight stop (yield = dose x ratio).
func exitReasonStop(code int) string {
	switch code {
	case 1, 9:
		return stopWeight
	case 4:
		return stopWater
	case 5:
		return stopTime
	}
	return stopNone
}

func hasPhaseIndex(phaseIndex []float64) bool {
	for _, pi := range phaseIndex {
		if _, ok := wholePhaseIndex(pi); ok {
			return true
		}
	}
	return false
}

// inferredPhases splits a shot without phase data into runs of samples with
// the same control type: flow-controlled when targetPumpFlow > 0, else
// pressure-controlled. Two adjacent profile phases of the same type merge.
func inferredPhases(timeInShot, targetPumpFlow []float64) []PhaseControl {
	var out []PhaseControl
	for i, tf := range targetPumpFlow {
		t := at(timeInShot, i)
		if math.IsNaN(tf) || math.IsNaN(t) {
			continue
		}
		control := controlPressure
		if tf > 0 {
			control = controlFlow
		}
		if len(out) == 0 || out[len(out)-1].Control != control {
			start := t / 10
			out = append(out, PhaseControl{Index: len(out), Control: control, Free: freeOf(control), StartS: &start})
		}
		end := t / 10
		out[len(out)-1].EndS = &end
	}
	return out
}

// gaggiMateTransition is one entry of the GaggiMate adapter's
// phaseTransitions list; T is deciseconds like timeInShot.
type gaggiMateTransition struct {
	T      float64 `json:"t"`
	Phase  int     `json:"phase"`
	Name   string  `json:"name"`
	Reason int     `json:"reason"`
}

// gaggiMatePhaseLog reads phaseTransitions and finalExitReason from a shot's
// datapoints in either shape. hasExit is false without a finalExitReason (a
// Gaggiuino shot or a GaggiMate log from before firmware 1.9.0).
func gaggiMatePhaseLog(v any) (transitions []gaggiMateTransition, finalExit int, hasExit bool) {
	var trRaw, exitRaw []byte
	switch t := v.(type) {
	case map[string]any:
		trRaw, _ = json.Marshal(t["phaseTransitions"])
		exitRaw, _ = json.Marshal(t["finalExitReason"])
	case stdjson.RawMessage:
		m := SplitSeries(t)
		trRaw, exitRaw = m["phaseTransitions"], m["finalExitReason"]
	case []byte:
		m := SplitSeries(t)
		trRaw, exitRaw = m["phaseTransitions"], m["finalExitReason"]
	}
	if !isJSONNull(trRaw) {
		if err := json.Unmarshal(trRaw, &transitions); err != nil {
			transitions = nil
		}
	}
	if !isJSONNull(exitRaw) && json.Unmarshal(exitRaw, &finalExit) == nil {
		hasExit = true
	}
	return transitions, finalExit, hasExit
}

// gaggiMatePhases builds one phase per recorded transition. A phase runs from
// its transition to the next one (the last phase to the last sample); the
// next transition's reason, or finalExitReason for the last phase, says why it
// ended.
func gaggiMatePhases(trs []gaggiMateTransition, finalExit int, timeInShot, targetPumpFlow []float64) []PhaseControl {
	last := 0.0
	for _, t := range timeInShot {
		if !math.IsNaN(t) && t > last {
			last = t
		}
	}
	out := make([]PhaseControl, len(trs))
	for k, tr := range trs {
		t0, t1, reason := tr.T, math.Max(last, tr.T), finalExit
		isLast := k+1 == len(trs)
		if !isLast {
			t1, reason = trs[k+1].T, trs[k+1].Reason
		}
		control := sampledControl(timeInShot, targetPumpFlow, t0, t1, isLast)
		start, end := t0/10, t1/10
		out[k] = PhaseControl{
			Index:      tr.Phase,
			Name:       tr.Name,
			Control:    control,
			Free:       freeOf(control),
			ExitReason: gaggiMateExitReasons[reason],
			StartS:     &start,
			EndS:       &end,
		}
	}
	return out
}

// sampledControl is the control type most samples in [t0, t1) ran under
// ([t0, t1] for the last phase): flow when more than half have
// targetPumpFlow > 0, pressure otherwise, unknown without a sample.
func sampledControl(timeInShot, targetPumpFlow []float64, t0, t1 float64, closed bool) string {
	flow, total := 0, 0
	for i, t := range timeInShot {
		tf := at(targetPumpFlow, i)
		if math.IsNaN(t) || math.IsNaN(tf) || t < t0 || t > t1 || (t == t1 && !closed) {
			continue
		}
		total++
		if tf > 0 {
			flow++
		}
	}
	switch {
	case total == 0:
		return controlUnknown
	case flow*2 > total:
		return controlFlow
	}
	return controlPressure
}
