package shots

import "testing"

func TestAvgActive(t *testing.T) {
	if _, ok := avgActive(nil, 1.5); ok {
		t.Error("avgActive(nil) should report ok=false")
	}
	if got, ok := avgActive([]float64{0, 2, 8, 9}, 1.5); !ok || got != (2.0+8.0+9.0)/3.0 {
		t.Errorf("avgActive(...) = %v, %v, want %v, true", got, ok, (2.0+8.0+9.0)/3.0)
	}
	// No value above threshold: falls back to the last sample, still ok.
	if got, ok := avgActive([]float64{0, 1, 0.5}, 1.5); !ok || got != 0.5 {
		t.Errorf("avgActive(all below threshold) = %v, %v, want 0.5, true", got, ok)
	}
}

func TestDetectPhases(t *testing.T) {
	times := []float64{0, 1, 5, 10, 15, 20, 25, 28}
	pressures := []float64{0, 2, 8.5, 9, 9.2, 9, 8.8, 7}
	pre, ext, endIdx, ok := detectPhases(times, pressures)
	if !ok {
		t.Fatal("expected phases to be detected")
	}
	if pre != 5 {
		t.Errorf("preinfusion = %v, want 5", pre)
	}
	if ext != 23 {
		t.Errorf("extraction = %v, want 23", ext)
	}
	if endIdx != 2 || times[endIdx] != pre {
		t.Errorf("endIdx = %d (times[endIdx] = %v), want 2 (%v)", endIdx, times[endIdx], pre)
	}

	// Fewer than 5 pressure samples: never detected.
	if _, _, _, ok := detectPhases(times[:3], pressures[:3]); ok {
		t.Error("expected <5 pressure samples to never detect phases")
	}

	// Pressure never crosses the 3.5 bar threshold: no phases.
	if _, _, _, ok := detectPhases(times, []float64{0, 1, 2, 2, 3, 3, 3, 3}); ok {
		t.Error("expected a curve that never crosses 3.5 bar to have no phases")
	}

	// Threshold crossed before 1s in: preinfusion would be <1.5s, rejected.
	if _, _, _, ok := detectPhases([]float64{0, 0.5, 0.8, 1, 1.5, 2}, []float64{0, 4, 5, 5, 5, 5}); ok {
		t.Error("expected an immediate-pressure curve (no real preinfusion) to have no phases")
	}
}

// TestShotYield pins the one yield rule the share card and ComputeShotMetrics
// now share: annotated totalWeight, else annotated yield (each only when > 0),
// else the maximum scale-weight sample.
func TestShotYield(t *testing.T) {
	cases := []struct {
		name   string
		shot   Shot
		want   float64
		wantOK bool
	}{
		{
			name: "annotation totalWeight wins over yield and scale weight",
			shot: Shot{
				"datapoints": map[string]any{"shotWeight": []any{100.0, 90.0}},
				"annotation": map[string]any{"totalWeight": 41.5, "yield": 38.0},
			},
			want: 41.5, wantOK: true,
		},
		{
			name: "annotation yield used when totalWeight absent",
			shot: Shot{
				"datapoints": map[string]any{"shotWeight": []any{100.0, 90.0}},
				"annotation": map[string]any{"yield": 37.5},
			},
			want: 37.5, wantOK: true,
		},
		{
			name: "maximum scale-weight sample when no annotation",
			shot: Shot{
				"datapoints": map[string]any{"shotWeight": []any{100.0, 360.0, 250.0}},
				"annotation": map[string]any{},
			},
			want: 36.0, wantOK: true,
		},
		{
			name: "weight series used when shotWeight absent",
			shot: Shot{
				"datapoints": map[string]any{"weight": []any{200.0, 330.0}},
				"annotation": map[string]any{},
			},
			want: 33.0, wantOK: true,
		},
		{
			name: "zero annotation ignored, falls back to scale weight",
			shot: Shot{
				"datapoints": map[string]any{"shotWeight": []any{100.0, 400.0}},
				"annotation": map[string]any{"totalWeight": 0.0, "yield": 0.0},
			},
			want: 40.0, wantOK: true,
		},
		{
			name: "negative annotation ignored",
			shot: Shot{
				"datapoints": map[string]any{"shotWeight": []any{100.0, 400.0}},
				"annotation": map[string]any{"totalWeight": -5.0},
			},
			want: 40.0, wantOK: true,
		},
		{
			name: "no usable data",
			shot: Shot{},
			want: 0, wantOK: false,
		},
		{
			name: "nil shot",
			shot: nil,
			want: 0, wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := shotYield(tc.shot)
			if ok != tc.wantOK || got != tc.want {
				t.Errorf("shotYield = (%v, %v), want (%v, %v)", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func shotWithDatapoints(duration int64, dose float64) Shot {
	return Shot{
		"duration": duration,
		"datapoints": map[string]any{
			"timeInShot": []any{float64(0), float64(10), float64(50), float64(100), float64(150), float64(200), float64(250), float64(280)},
			"pressure":   []any{float64(0), float64(20), float64(85), float64(90), float64(92), float64(90), float64(88), float64(85)},
			"shotWeight": []any{float64(0), float64(0), float64(20), float64(80), float64(150), float64(230), float64(300), float64(360)},
		},
		"annotation": map[string]any{
			"dose": dose,
		},
	}
}

func TestComputeShotMetrics(t *testing.T) {
	m := ComputeShotMetrics(shotWithDatapoints(280, 18))

	if !m.HasDose || m.DoseG != 18 {
		t.Errorf("DoseG = %v, HasDose = %v, want 18, true", m.DoseG, m.HasDose)
	}
	if !m.HasYield || m.YieldG != 36 {
		t.Errorf("YieldG = %v, HasYield = %v, want 36, true", m.YieldG, m.HasYield)
	}
	if !m.HasRatio || m.Ratio != 2 {
		t.Errorf("Ratio = %v, HasRatio = %v, want 2, true", m.Ratio, m.HasRatio)
	}
	if m.HasEY {
		t.Error("HasEY should be false with no tds annotated")
	}
	if m.DurationSecs != 28 {
		t.Errorf("DurationSecs = %v, want 28", m.DurationSecs)
	}
	if !m.HasPhases || m.PreinfusionSecs != 5 || m.ExtractionSecs != 23 {
		t.Errorf("phases = %v/%v/%v, want 5/23/true", m.PreinfusionSecs, m.ExtractionSecs, m.HasPhases)
	}
	if m.Channeling {
		t.Error("expected no channeling for this smooth curve")
	}

	if got := ComputeShotMetrics(nil); got.HasDose || got.HasYield || got.HasRatio {
		t.Errorf("ComputeShotMetrics(nil) = %+v, want a zero value", got)
	}
}
