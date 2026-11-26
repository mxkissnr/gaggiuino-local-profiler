package shots

import (
	stdjson "encoding/json"
	"reflect"
	"testing"
)

func ptrIs(p *float64, want float64) bool {
	return p != nil && *p == want
}

// adaptiveProfile is the demo "Adaptive" Gaggiuino profile: a global weight
// stop, a 15 g -> 33 g recipe and four phases FLOW, PRESSURE, PRESSURE, FLOW.
func adaptiveProfile() map[string]any {
	return map[string]any{
		"name":                 "Adaptive",
		"globalStopConditions": map[string]any{"weight": 37.0},
		"recipe":               map[string]any{"coffeeIn": 15.0, "coffeeOut": 33.0},
		"phases": []any{
			map[string]any{"type": "FLOW", "target": map[string]any{"curve": "INSTANT", "end": 7.0}, "restriction": 3.0,
				"stopConditions": map[string]any{"pressureAbove": 3.0, "time": 20000.0, "waterPumpedInPhase": 60.0}},
			map[string]any{"type": "PRESSURE", "target": map[string]any{"curve": "INSTANT", "end": 3.0},
				"stopConditions": map[string]any{"time": 6000.0}},
			map[string]any{"type": "PRESSURE", "target": map[string]any{"curve": "LINEAR", "end": 9.0, "time": 5000.0},
				"stopConditions": map[string]any{"time": 5000.0}},
			map[string]any{"type": "FLOW", "target": map[string]any{"curve": "LINEAR", "end": 2.5, "time": 25000.0}, "restriction": 9.0,
				"stopConditions": map[string]any{}},
		},
	}
}

func adaptiveDatapoints() map[string]any {
	return map[string]any{
		"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0},
		"phaseIndex":     []any{0.0, 0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0},
		"targetPumpFlow": []any{70.0, 70.0, 0.0, 0.0, 0.0, 0.0, 25.0, 25.0},
	}
}

// TestResolveShotControlAdaptiveWeightStop covers the Adaptive profile
// (#2219): a global 37 g weight stop, a 15 g -> 33 g recipe, four phases
// timed by the phaseIndex series, and the raw-datapoints shape resolving
// identically to the map shape.
func TestResolveShotControlAdaptiveWeightStop(t *testing.T) {
	shot := Shot{"profileName": nil, "profile": adaptiveProfile(), "datapoints": adaptiveDatapoints()}
	c := ResolveShotControl(shot)

	if c.StopMode != stopWeight || !ptrIs(c.StopTarget, 37) || c.StopFrom != "global" || c.FreeResult != "time" {
		t.Errorf("stop = %q/%v/%q free %q, want weight/37/global/time", c.StopMode, c.StopTarget, c.StopFrom, c.FreeResult)
	}
	if c.Recipe == nil || !ptrIs(c.Recipe.DoseG, 15) || !ptrIs(c.Recipe.YieldG, 33) || c.Recipe.Ratio != nil {
		t.Errorf("recipe = %+v, want 15 g in, 33 g out, no ratio", c.Recipe)
	}
	if c.Source != sourceProfile || c.ProfileName != "Adaptive" {
		t.Errorf("source %q profile %q, want profile/Adaptive", c.Source, c.ProfileName)
	}
	if len(c.Phases) != 4 {
		t.Fatalf("got %d phases, want 4", len(c.Phases))
	}
	wantControl := []string{controlFlow, controlPressure, controlPressure, controlFlow}
	wantFree := []string{controlPressure, controlFlow, controlFlow, controlPressure}
	for i := range c.Phases {
		if c.Phases[i].Control != wantControl[i] || c.Phases[i].Free != wantFree[i] {
			t.Errorf("phase %d control/free = %q/%q, want %q/%q", i,
				c.Phases[i].Control, c.Phases[i].Free, wantControl[i], wantFree[i])
		}
	}

	p0 := c.Phases[0]
	if !ptrIs(p0.TargetEnd, 7) || !ptrIs(p0.Restriction, 3) {
		t.Errorf("phase 0 target/restriction = %v/%v, want 7/3", p0.TargetEnd, p0.Restriction)
	}
	wantConds := map[string]float64{"pressureAbove": 3, "time": 20000, "waterPumpedInPhase": 60}
	if !reflect.DeepEqual(p0.StopConditions, wantConds) {
		t.Errorf("phase 0 stop conditions = %v, want %v", p0.StopConditions, wantConds)
	}
	if !ptrIs(p0.StartS, 0) || !ptrIs(p0.EndS, 1) {
		t.Errorf("phase 0 timing = %v..%v, want 0..1", p0.StartS, p0.EndS)
	}

	p1 := c.Phases[1]
	if !ptrIs(p1.StartS, 2) || !ptrIs(p1.EndS, 3) {
		t.Errorf("phase 1 timing = %v..%v, want 2..3", p1.StartS, p1.EndS)
	}

	p3 := c.Phases[3]
	if !ptrIs(p3.TargetEnd, 2.5) || !ptrIs(p3.Restriction, 9) || p3.StopConditions != nil {
		t.Errorf("phase 3 = %+v, want target 2.5, restriction 9, no stop conditions", p3)
	}
	if !ptrIs(p3.StartS, 6) || !ptrIs(p3.EndS, 7) {
		t.Errorf("phase 3 timing = %v..%v, want 6..7", p3.StartS, p3.EndS)
	}

	raw, err := stdjson.Marshal(adaptiveDatapoints())
	if err != nil {
		t.Fatalf("marshal datapoints: %v", err)
	}
	rawShot := Shot{"profileName": nil, "profile": adaptiveProfile(), "datapoints": stdjson.RawMessage(raw)}
	if got := ResolveShotControl(rawShot); !reflect.DeepEqual(got, c) {
		t.Errorf("raw datapoints resolve differently:\n got %+v\nwant %+v", got, c)
	}
}

// TestResolveShotControlStopModes covers where a Gaggiuino shot's stop comes
// from (#2219): the global conditions first, else the last phase's, weight
// over water over time within one set, and no stop for a pressure-only
// condition.
func TestResolveShotControlStopModes(t *testing.T) {
	flowPhase := func(stop map[string]any) map[string]any {
		return map[string]any{"type": "FLOW", "stopConditions": stop}
	}
	pressurePhase := func(stop map[string]any) map[string]any {
		return map[string]any{"type": "PRESSURE", "stopConditions": stop}
	}

	tests := []struct {
		name   string
		shot   Shot
		mode   string
		target *float64
		from   string
		free   string
	}{
		{
			name:   "global weight beats the time cap next to it",
			shot:   Shot{"profile": map[string]any{"globalStopConditions": map[string]any{"weight": 36.0, "time": 60000.0}}},
			mode:   stopWeight,
			target: ptr(36),
			from:   "global",
			free:   "time",
		},
		{
			name:   "global time is reported in seconds",
			shot:   Shot{"profile": map[string]any{"globalStopConditions": map[string]any{"time": 30000.0}}},
			mode:   stopTime,
			target: ptr(30),
			from:   "global",
			free:   "yield",
		},
		{
			name:   "global water",
			shot:   Shot{"profile": map[string]any{"globalStopConditions": map[string]any{"waterPumped": 50.0}}},
			mode:   stopWater,
			target: ptr(50),
			from:   "global",
			free:   "yield",
		},
		{
			name: "zero global weight falls back to the last phase",
			shot: Shot{"profile": map[string]any{
				"globalStopConditions": map[string]any{"weight": 0.0},
				"phases": []any{
					flowPhase(map[string]any{"weight": 4.0}),
					pressurePhase(map[string]any{"time": 25000.0}),
				},
			}},
			mode:   stopTime,
			target: ptr(25),
			from:   "last_phase",
			free:   "yield",
		},
		{
			name: "last phase weight without global conditions",
			shot: Shot{"profile": map[string]any{
				"phases": []any{pressurePhase(map[string]any{"weight": 36.0})},
			}},
			mode:   stopWeight,
			target: ptr(36),
			from:   "last_phase",
			free:   "time",
		},
		{
			name: "pressure stop only is no stop mode",
			shot: Shot{"profile": map[string]any{
				"phases": []any{pressurePhase(map[string]any{"pressureBelow": 2.0})},
			}},
			mode: stopNone,
			from: "",
			free: "unknown",
		},
		{
			name: "none for an empty profile",
			shot: Shot{"profile": map[string]any{}},
			mode: stopNone,
			from: "",
			free: "unknown",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := ResolveShotControl(tc.shot)
			if c.StopMode != tc.mode || c.StopFrom != tc.from || c.FreeResult != tc.free {
				t.Errorf("stop = %q/%q free %q, want %q/%q free %q",
					c.StopMode, c.StopFrom, c.FreeResult, tc.mode, tc.from, tc.free)
			}
			if tc.target == nil {
				if c.StopTarget != nil {
					t.Errorf("stop target = %v, want nil", *c.StopTarget)
				}
			} else if !ptrIs(c.StopTarget, *tc.target) {
				t.Errorf("stop target = %v, want %v", c.StopTarget, *tc.target)
			}
		})
	}
}

// TestResolveShotControlNoProfileData covers shots without an embedded
// profile (#2219): no phases, no stop and no recipe, with Phases an empty
// non-nil slice so the tool always emits an array.
func TestResolveShotControlNoProfileData(t *testing.T) {
	shots := []Shot{
		{"datapoints": map[string]any{
			"timeInShot": []any{0.0, 10.0},
			"pressure":   []any{90.0, 90.0},
		}},
		{},
	}
	for i, shot := range shots {
		c := ResolveShotControl(shot)
		if c.Source != sourceNone || c.StopMode != stopNone || c.StopFrom != "" || c.FreeResult != "unknown" {
			t.Errorf("shot %d: source/stop = %q/%q/%q free %q, want none/none/\"\"/unknown",
				i, c.Source, c.StopMode, c.StopFrom, c.FreeResult)
		}
		if c.StopTarget != nil || c.Recipe != nil {
			t.Errorf("shot %d: target %v recipe %v, want nil", i, c.StopTarget, c.Recipe)
		}
		if c.Phases == nil || len(c.Phases) != 0 {
			t.Errorf("shot %d: phases = %#v, want an empty non-nil slice", i, c.Phases)
		}
	}
}

// TestResolveShotControlRecipeRatio covers a ratio-only recipe (#2219): dose
// and ratio read, yield left nil.
func TestResolveShotControlRecipeRatio(t *testing.T) {
	c := ResolveShotControl(Shot{"profile": map[string]any{
		"recipe": map[string]any{"coffeeIn": 18.0, "ratio": 2.0},
	}})
	if c.Recipe == nil || !ptrIs(c.Recipe.DoseG, 18) || c.Recipe.YieldG != nil || !ptrIs(c.Recipe.Ratio, 2) {
		t.Errorf("recipe = %+v, want dose 18, no yield, ratio 2", c.Recipe)
	}
}

func ptr(v float64) *float64 { return &v }

// TestResolveShotControlInfersWithoutPhaseIndex covers shots without a
// phaseIndex series (#2219): the control type is inferred per sample from
// targetPumpFlow, and consecutive samples of one class form one phase.
func TestResolveShotControlInfersWithoutPhaseIndex(t *testing.T) {
	dp := adaptiveDatapoints()
	delete(dp, "phaseIndex")
	c := ResolveShotControl(Shot{"profile": adaptiveProfile(), "datapoints": dp})

	if c.Source != sourceInferred {
		t.Errorf("source = %q, want inferred", c.Source)
	}
	if c.StopMode != stopWeight || !ptrIs(c.StopTarget, 37) || c.StopFrom != "global" {
		t.Errorf("stop = %q/%v/%q, want weight/37/global", c.StopMode, c.StopTarget, c.StopFrom)
	}
	want := []struct {
		control string
		start   float64
		end     float64
	}{
		{controlFlow, 0, 1},
		{controlPressure, 2, 5},
		{controlFlow, 6, 7},
	}
	if len(c.Phases) != len(want) {
		t.Fatalf("got %d phases, want %d: %+v", len(c.Phases), len(want), c.Phases)
	}
	for i, w := range want {
		p := c.Phases[i]
		if p.Index != i || p.Control != w.control || p.Free != freeOf(w.control) {
			t.Errorf("phase %d = %+v, want index %d control %q", i, p, i, w.control)
		}
		if !ptrIs(p.StartS, w.start) || !ptrIs(p.EndS, w.end) {
			t.Errorf("phase %d timing = %v..%v, want %v..%v", i, p.StartS, p.EndS, w.start, w.end)
		}
		if p.TargetEnd != nil || p.Restriction != nil || p.StopConditions != nil || p.ExitReason != "" || p.Name != "" {
			t.Errorf("phase %d = %+v, want inferred fields only", i, p)
		}
	}

	raw, err := stdjson.Marshal(dp)
	if err != nil {
		t.Fatalf("marshal datapoints: %v", err)
	}
	rawShot := Shot{"profile": adaptiveProfile(), "datapoints": stdjson.RawMessage(raw)}
	if got := ResolveShotControl(rawShot); !reflect.DeepEqual(got, c) {
		t.Errorf("raw datapoints resolve differently:\n got %+v\nwant %+v", got, c)
	}

	// A GaggiMate shot without a phase log and without a profile.
	gm := ResolveShotControl(Shot{"machineType": "gaggimate", "datapoints": map[string]any{
		"timeInShot":     []any{0.0, 10.0, 20.0},
		"targetPumpFlow": []any{40.0, 0.0, 0.0},
	}})
	if gm.Source != sourceInferred || gm.StopMode != stopNone || gm.StopFrom != "" || gm.FreeResult != "unknown" {
		t.Errorf("gaggimate: source/stop = %q/%q/%q free %q, want inferred/none/\"\"/unknown",
			gm.Source, gm.StopMode, gm.StopFrom, gm.FreeResult)
	}
	if len(gm.Phases) != 2 {
		t.Fatalf("gaggimate: got %d phases, want 2: %+v", len(gm.Phases), gm.Phases)
	}
	if p := gm.Phases[0]; p.Control != controlFlow || !ptrIs(p.StartS, 0) || !ptrIs(p.EndS, 0) {
		t.Errorf("gaggimate phase 0 = %+v, want flow 0..0", p)
	}
	if p := gm.Phases[1]; p.Control != controlPressure || !ptrIs(p.StartS, 1) || !ptrIs(p.EndS, 2) {
		t.Errorf("gaggimate phase 1 = %+v, want pressure 1..2", p)
	}
}

// gaggiMateDatapoints is a GaggiMate shot log: a 3 s flow preinfusion, then a
// 5 s pressure brew recorded with phaseTransitions and an exit reason.
func gaggiMateDatapoints(exit int) map[string]any {
	return map[string]any{
		"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0},
		"targetPumpFlow": []any{40.0, 40.0, 40.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
		"phaseTransitions": []any{
			map[string]any{"t": 0, "phase": 0, "name": "Preinfusion", "reason": 0},
			map[string]any{"t": 30, "phase": 1, "name": "Brew", "reason": 5},
		},
		"finalExitReason": exit,
	}
}

// TestResolveShotControlGaggiMate covers GaggiMate shots (#2219): the stop
// comes from finalExitReason, phases from phaseTransitions, and the raw
// datapoints shape resolves identically to the map shape.
func TestResolveShotControlGaggiMate(t *testing.T) {
	shot := Shot{"machineType": "gaggimate", "profileName": "Turbo", "datapoints": gaggiMateDatapoints(1)}
	c := ResolveShotControl(shot)

	if c.StopMode != stopWeight || c.StopTarget != nil || c.StopFrom != "exit_reason" || c.FreeResult != "time" {
		t.Errorf("stop = %q/%v/%q free %q, want weight/nil/exit_reason/time",
			c.StopMode, c.StopTarget, c.StopFrom, c.FreeResult)
	}
	if c.Source != sourceInferred || c.Recipe != nil || c.ProfileName != "Turbo" {
		t.Errorf("source/recipe/profile = %q/%v/%q, want inferred/nil/Turbo", c.Source, c.Recipe, c.ProfileName)
	}
	if len(c.Phases) != 2 {
		t.Fatalf("got %d phases, want 2: %+v", len(c.Phases), c.Phases)
	}
	p0, p1 := c.Phases[0], c.Phases[1]
	if p0.Index != 0 || p0.Name != "Preinfusion" || p0.Control != controlFlow || p0.Free != controlPressure {
		t.Errorf("phase 0 = %+v, want Preinfusion flow/free pressure", p0)
	}
	if p0.ExitReason != "time" || !ptrIs(p0.StartS, 0) || !ptrIs(p0.EndS, 3) {
		t.Errorf("phase 0 exit/timing = %q %v..%v, want time 0..3", p0.ExitReason, p0.StartS, p0.EndS)
	}
	if p1.Index != 1 || p1.Name != "Brew" || p1.Control != controlPressure || p1.Free != controlFlow {
		t.Errorf("phase 1 = %+v, want Brew pressure/free flow", p1)
	}
	if p1.ExitReason != "weight" || !ptrIs(p1.StartS, 3) || !ptrIs(p1.EndS, 8) {
		t.Errorf("phase 1 exit/timing = %q %v..%v, want weight 3..8", p1.ExitReason, p1.StartS, p1.EndS)
	}

	raw, err := stdjson.Marshal(shot["datapoints"])
	if err != nil {
		t.Fatalf("marshal datapoints: %v", err)
	}
	rawShot := Shot{"machineType": "gaggimate", "profileName": "Turbo", "datapoints": stdjson.RawMessage(raw)}
	if got := ResolveShotControl(rawShot); !reflect.DeepEqual(got, c) {
		t.Errorf("raw datapoints resolve differently:\n got %+v\nwant %+v", got, c)
	}

	stopped := ResolveShotControl(Shot{"machineType": "gaggimate", "datapoints": gaggiMateDatapoints(7)})
	if stopped.StopMode != stopNone || stopped.StopFrom != "" || stopped.FreeResult != "unknown" {
		t.Errorf("manual stop = %q/%q free %q, want none/\"\"/unknown",
			stopped.StopMode, stopped.StopFrom, stopped.FreeResult)
	}
	if last := stopped.Phases[len(stopped.Phases)-1]; last.ExitReason != "manual" {
		t.Errorf("last phase exit reason = %q, want manual", last.ExitReason)
	}

	water := ResolveShotControl(Shot{"machineType": "gaggimate", "datapoints": gaggiMateDatapoints(4)})
	if water.StopMode != stopWater || water.FreeResult != "yield" {
		t.Errorf("water stop = %q free %q, want water/yield", water.StopMode, water.FreeResult)
	}

	ratio := ResolveShotControl(Shot{"machineType": "gaggimate", "datapoints": gaggiMateDatapoints(9)})
	if ratio.StopMode != stopWeight {
		t.Errorf("ratio stop = %q, want weight", ratio.StopMode)
	}
}
