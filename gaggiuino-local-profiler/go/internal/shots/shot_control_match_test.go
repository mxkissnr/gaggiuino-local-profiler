package shots

import "testing"

// matchShot builds a Gaggiuino shot without phaseIndex from its profile
// phases and its time and target series (series units: x10, time in ds).
func matchShot(phases []any, timeInShot, targetPressure, targetPumpFlow []any) Shot {
	return Shot{
		"profile": map[string]any{"name": "Match", "phases": phases},
		"datapoints": map[string]any{
			"timeInShot":     timeInShot,
			"targetPressure": targetPressure,
			"targetPumpFlow": targetPumpFlow,
		},
	}
}

func instantPhase(typ string, end float64, extra map[string]any) map[string]any {
	p := map[string]any{"type": typ, "target": map[string]any{"curve": "INSTANT", "end": end}}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

// TestResolveShotControlMatchesProfilePhases covers shots without phaseIndex
// that carry an embedded profile (#2221): the target series are aligned to
// the profile's phases, so each phase keeps its profile control type.
func TestResolveShotControlMatchesProfilePhases(t *testing.T) {
	timed := func(ms float64) map[string]any {
		return map[string]any{"stopConditions": map[string]any{"time": ms}}
	}
	t8 := []any{5.0, 15.0, 25.0, 35.0, 45.0, 55.0, 65.0, 75.0}
	type span struct {
		control    string
		start, end float64
	}
	tests := []struct {
		name   string
		shot   Shot
		source string
		phases []span // per profile phase; start -1: the phase ran no sample
	}{
		{
			name: "pressure phase with a flow limit resolves as pressure",
			shot: matchShot([]any{
				instantPhase("FLOW", 3, map[string]any{"restriction": 4.0, "stopConditions": map[string]any{"time": 3000.0}}),
				instantPhase("PRESSURE", 9, map[string]any{"restriction": 3.0}),
			}, t8,
				[]any{40.0, 40.0, 40.0, 90.0, 90.0, 90.0, 90.0, 90.0},
				[]any{30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0}),
			source: sourceMatched,
			phases: []span{{controlFlow, 0.5, 2.5}, {controlPressure, 3.5, 7.5}},
		},
		{
			name: "flow phase with target end 0 resolves as flow",
			shot: matchShot([]any{
				instantPhase("FLOW", 0, timed(2000.0)),
				instantPhase("PRESSURE", 9, nil),
			}, t8[:6],
				[]any{0.0, 0.0, 90.0, 90.0, 90.0, 90.0},
				[]any{0.0, 0.0, 0.0, 0.0, 0.0, 0.0}),
			source: sourceMatched,
			phases: []span{{controlFlow, 0.5, 1.5}, {controlPressure, 2.5, 5.5}},
		},
		{
			name: "adjacent pressure phases at one target split at the time stop",
			shot: matchShot([]any{
				instantPhase("PRESSURE", 9, timed(3000.0)),
				instantPhase("PRESSURE", 9, nil),
			}, t8,
				[]any{90.0, 90.0, 90.0, 90.0, 90.0, 90.0, 90.0, 90.0},
				[]any{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0}),
			source: sourceMatched,
			phases: []span{{controlPressure, 0.5, 2.5}, {controlPressure, 3.5, 7.5}},
		},
		{
			name: "a phase marked skip runs no sample",
			shot: matchShot([]any{
				instantPhase("FLOW", 2, timed(2000.0)),
				instantPhase("PRESSURE", 3, map[string]any{"skip": true, "stopConditions": map[string]any{"time": 5000.0}}),
				instantPhase("PRESSURE", 9, nil),
			}, t8[:6],
				[]any{0.0, 0.0, 90.0, 90.0, 90.0, 90.0},
				[]any{20.0, 20.0, 0.0, 0.0, 0.0, 0.0}),
			source: sourceMatched,
			phases: []span{{controlFlow, 0.5, 1.5}, {controlPressure, -1, -1}, {controlPressure, 2.5, 5.5}},
		},
		{
			name: "targets that contradict the profile fall back to inferred",
			shot: matchShot([]any{instantPhase("PRESSURE", 9, nil)}, t8[:4],
				[]any{0.0, 0.0, 0.0, 0.0},
				[]any{40.0, 40.0, 40.0, 40.0}),
			source: sourceInferred,
			phases: []span{{controlFlow, 0.5, 3.5}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := ResolveShotControl(tc.shot)
			if c.Source != tc.source {
				t.Fatalf("source = %q, want %q", c.Source, tc.source)
			}
			if len(c.Phases) != len(tc.phases) {
				t.Fatalf("got %d phases, want %d: %+v", len(c.Phases), len(tc.phases), c.Phases)
			}
			for i, w := range tc.phases {
				p := c.Phases[i]
				if p.Control != w.control || p.Free != freeOf(w.control) {
					t.Errorf("phase %d control/free = %q/%q, want %q", i, p.Control, p.Free, w.control)
				}
				if w.start < 0 {
					if p.StartS != nil || p.EndS != nil {
						t.Errorf("phase %d timing = %v..%v, want none", i, p.StartS, p.EndS)
					}
				} else if !ptrIs(p.StartS, w.start) || !ptrIs(p.EndS, w.end) {
					t.Errorf("phase %d timing = %v..%v, want %v..%v", i, p.StartS, p.EndS, w.start, w.end)
				}
			}
		})
	}

	// A GaggiMate shot never goes through the matcher, even with a profile
	// and both target series.
	gm := tests[2].shot
	gm["machineType"] = "gaggimate"
	if c := ResolveShotControl(gm); c.Source != sourceInferred {
		t.Errorf("gaggimate source = %q, want inferred", c.Source)
	}
}
