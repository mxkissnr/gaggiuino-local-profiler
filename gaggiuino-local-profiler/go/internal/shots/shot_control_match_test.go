package shots

import (
	"archive/zip"
	stdjson "encoding/json"
	"io"
	"math"
	"testing"
)

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

// TestMatchProfilePhasesDemoAgreement measures the matcher against ground
// truth (#2221): every demo shot that has a phaseIndex series is matched
// with that series removed, and the matched phase index per sample and the
// phase count are compared with the real ones.
func TestMatchProfilePhasesDemoAgreement(t *testing.T) {
	zr, err := zip.OpenReader("../../../demo/glp-demo-backup.zip")
	if err != nil {
		t.Fatalf("open demo backup: %v", err)
	}
	defer zr.Close()
	var raw []byte
	for _, f := range zr.File {
		if f.Name != "backup.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open backup.json: %v", err)
		}
		raw, err = io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read backup.json: %v", err)
		}
	}
	var backup struct {
		Shots []map[string]any `json:"shots"`
	}
	if err := stdjson.Unmarshal(raw, &backup); err != nil {
		t.Fatalf("decode backup.json: %v", err)
	}

	distinct := func(s []float64) int {
		seen := map[float64]bool{}
		for _, v := range s {
			if !math.IsNaN(v) {
				seen[v] = true
			}
		}
		return len(seen)
	}
	shots, exact, agree, samples := 0, 0, 0, 0
	for _, sh := range backup.Shots {
		dp, _ := sh["datapoints"].(map[string]any)
		phases, _ := toMap(sh["profile"])["phases"].([]any)
		truth := alignedSeries(dp, "phaseIndex")["phaseIndex"]
		if len(phases) == 0 || !hasPhaseIndex(truth) {
			continue
		}
		stripped := map[string]any{}
		for k, v := range dp {
			if k != "phaseIndex" {
				stripped[k] = v
			}
		}
		series := alignedSeries(stripped, "timeInShot", "targetPressure", "targetPumpFlow",
			"pressure", "pumpFlow", "shotWeight", "waterPumped")
		got := matchProfilePhases(Shot(sh), phases, series)
		shots++
		for i, want := range truth {
			if _, ok := wholePhaseIndex(want); !ok {
				continue
			}
			samples++
			if at(got, i) == want {
				agree++
			}
		}
		if got != nil && distinct(got) == distinct(truth) {
			exact++
		}
	}
	if shots < 50 {
		t.Fatalf("only %d demo shots with phaseIndex, want at least 50", shots)
	}
	sampleShare := float64(agree) / float64(samples)
	countShare := float64(exact) / float64(shots)
	t.Logf("%d shots: sample agreement %.2f%%, exact phase count %.2f%%", shots, 100*sampleShare, 100*countShare)
	if sampleShare < 0.95 {
		t.Errorf("sample agreement %.4f, want >= 0.95", sampleShare)
	}
	if countShare < 0.90 {
		t.Errorf("exact phase count %.4f, want >= 0.90", countShare)
	}
}
