package shots

import "testing"

func TestStddev(t *testing.T) {
	if got := stddev(nil); got != 0 {
		t.Errorf("stddev(nil) = %v, want 0", got)
	}
	if got := stddev([]float64{5}); got != 0 {
		t.Errorf("stddev(single) = %v, want 0", got)
	}
	if got := stddev([]float64{2, 4, 4, 4, 5, 5, 7, 9}); got < 2.0 || got > 2.1 {
		t.Errorf("stddev(...) = %v, want ~2.0", got)
	}
}

func TestDetectChanneling(t *testing.T) {
	// A sharp pressure drop (>1.5 bar) within a 0-3s window, starting from
	// >=5 bar, is channeling.
	times := []float64{0, 1, 2, 3, 4, 5}
	pressuresChanneling := []float64{6, 6, 6, 3, 3, 3}
	if !detectChanneling(times, pressuresChanneling) {
		t.Error("expected channeling to be detected")
	}

	pressuresStable := []float64{6, 6.2, 6.1, 6.3, 6.2, 6.1}
	if detectChanneling(times, pressuresStable) {
		t.Error("expected no channeling for a stable pressure curve")
	}

	// Below 5 samples never counts as channeling, regardless of the curve.
	if detectChanneling(times[:4], []float64{6, 1, 6, 1}) {
		t.Error("expected <5 samples to never be flagged as channeling")
	}

	// A drop starting below 5 bar doesn't count.
	if detectChanneling(times, []float64{4, 4, 4, 1, 1, 1}) {
		t.Error("expected a drop starting below 5 bar to not be flagged")
	}

	// times shorter than pressures must not panic and must not false-positive.
	if detectChanneling(times[:2], pressuresChanneling) {
		t.Error("expected out-of-range time samples to be skipped, not flagged")
	}
}

func TestParseBrewRatioTarget(t *testing.T) {
	cases := []struct {
		in      string
		want    float64
		wantOK  bool
		comment string
	}{
		{"1:2.4", 2.4, true, "standard form"},
		{"1 : 2", 2, true, "spaced form"},
		{"", 0, false, "empty"},
		{"not a ratio", 0, false, "freeform notes"},
		{"2:1", 0, false, "wrong left side"},
	}
	for _, c := range cases {
		got, ok := parseBrewRatioTarget(c.in)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("%s: parseBrewRatioTarget(%q) = (%v, %v), want (%v, %v)", c.comment, c.in, got, ok, c.want, c.wantOK)
		}
	}
}

// mkPoints builds a JSON-decoded-shape []any of float64, the same
// representation encoding/json produces for a JSON array of numbers —
// score.go's floatSlice expects exactly this shape.
func mkPoints(vals ...float64) []any {
	out := make([]any, len(vals))
	for i, v := range vals {
		out[i] = v
	}
	return out
}

// fullScoreShot builds a shot whose every scored dimension lands exactly
// on the top of its band, so the weighted total is a clean 100 — see the
// per-component comments for the arithmetic.
func fullScoreShot(durationTenths float64) Shot {
	pressure := make([]any, 20)
	temperature := make([]any, 10)
	timeInShot := make([]any, 20)
	for i := range pressure {
		pressure[i] = 80.0 // /10 = 8.0 bar, inside [7, 9.5] -> 100
		timeInShot[i] = float64(i) * 10
	}
	for i := range temperature {
		temperature[i] = 900.0 // /10 = 90.0C, stddev 0 -> stab 100, inside [90,96] -> acc 100
	}
	return Shot{
		"duration": durationTenths, // /10 = 30s, inside [25,35] -> 100
		"datapoints": map[string]any{
			"pressure":    pressure,
			"temperature": temperature,
			"timeInShot":  timeInShot,
			"weight":      mkPoints(0, 450), // /10 max = 45
		},
		"annotation": map[string]any{
			"dose": 18.0, // 45/18 = 2.5, inside [1.8,2.5] -> 100
		},
	}
}

func TestCalcShotScoreDetail_FullScore(t *testing.T) {
	shot := fullScoreShot(300)
	detail := CalcShotScoreDetail(shot, nil)
	if detail.Score == nil {
		t.Fatal("expected a non-nil score")
	}
	if *detail.Score != 100 {
		t.Errorf("score = %d, want 100", *detail.Score)
	}
	if detail.UsedBeanTarget {
		t.Error("expected usedBeanTarget = false with no bean")
	}
}

func TestCalcShotScoreDetail_NilShot(t *testing.T) {
	detail := CalcShotScoreDetail(nil, nil)
	if detail.Score != nil {
		t.Errorf("expected nil score for a nil shot, got %v", *detail.Score)
	}
}

func TestCalcShotScoreDetail_InsufficientPressureSamples(t *testing.T) {
	shot := Shot{
		"duration": 300.0,
		"datapoints": map[string]any{
			"pressure": mkPoints(80, 80, 80), // only 3 samples >= 5 bar -> "not enough data"
		},
	}
	detail := CalcShotScoreDetail(shot, nil)
	if detail.Score != nil {
		t.Errorf("expected nil score with <=3 pressure samples, got %d", *detail.Score)
	}
}

func TestCalcShotScoreDetail_BeanTargetUsedOnlyWhenBeanPassed(t *testing.T) {
	shot := fullScoreShot(300)
	beanTemp := 90.0
	bean := &Bean{BrewTempC: &beanTemp}

	withoutBean := CalcShotScoreDetail(shot, nil)
	withBean := CalcShotScoreDetail(shot, bean)

	if withoutBean.UsedBeanTarget {
		t.Error("expected usedBeanTarget = false without a bean")
	}
	// The shot has no targetTemperature curve, so a bean's brewTempC is
	// used as the accuracy target instead of the generic 90-96 band.
	if !withBean.UsedBeanTarget {
		t.Error("expected usedBeanTarget = true when a bean with brewTempC is passed and no target curve exists")
	}
}

func TestCalcShotScoreDetail_BeanRatioTargetUsed(t *testing.T) {
	shot := fullScoreShot(300)
	bean := &Bean{BrewRatio: "1:2.5"} // matches the shot's actual 45/18=2.5 ratio exactly
	detail := CalcShotScoreDetail(shot, bean)
	if !detail.UsedBeanTarget {
		t.Error("expected usedBeanTarget = true when the bean has a parseable brewRatio")
	}
	if detail.Score == nil || *detail.Score != 100 {
		t.Errorf("score = %v, want 100 (dev=0 from bean ratio target)", detail.Score)
	}
}

// TestCalcShotScoreDetail_DurationAsInt64 pins that shot["duration"] works
// scored the same whether it's a float64 (as tests build it by hand) or an
// int64 (as hydrateRow actually stores it, scanned straight off the shots
// table's INTEGER column) — see toFloat's doc comment.
func TestCalcShotScoreDetail_DurationAsInt64(t *testing.T) {
	shot := fullScoreShot(300)
	shot["duration"] = int64(300)
	detail := CalcShotScoreDetail(shot, nil)
	if detail.Score == nil || *detail.Score != 100 {
		t.Errorf("score with int64 duration = %v, want 100", detail.Score)
	}
}

func TestCalcShotScore_WrapsDetail(t *testing.T) {
	shot := fullScoreShot(300)
	score := CalcShotScore(shot, nil)
	if score == nil || *score != 100 {
		t.Errorf("CalcShotScore = %v, want 100", score)
	}
}

func componentByName(t *testing.T, components []ScoreComponent, name string) *ScoreComponent {
	t.Helper()
	for i := range components {
		if components[i].Name == name {
			return &components[i]
		}
	}
	t.Fatalf("no %q component in %+v", name, components)
	return nil
}

func TestCalcShotScoreDetail_Components(t *testing.T) {
	detail := CalcShotScoreDetail(fullScoreShot(300), nil)
	if detail.Score == nil {
		t.Fatal("expected a non-nil score")
	}
	wantNames := []string{"pressure", "temperature", "duration", "ratio", "channeling"}
	wantWeights := []int{25, 20, 20, 20, 15}
	if len(detail.Components) != len(wantNames) {
		t.Fatalf("components = %d, want %d: %+v", len(detail.Components), len(wantNames), detail.Components)
	}
	var sumScoreWeight, sumWeight int
	for i, c := range detail.Components {
		if c.Name != wantNames[i] {
			t.Errorf("component %d name = %q, want %q", i, c.Name, wantNames[i])
		}
		if c.Weight != wantWeights[i] {
			t.Errorf("component %d weight = %d, want %d", i, c.Weight, wantWeights[i])
		}
		if c.Target != "generic" {
			t.Errorf("component %d target = %q, want generic", i, c.Target)
		}
		sumScoreWeight += c.Score * c.Weight
		sumWeight += c.Weight
	}
	if got := jsRound(float64(sumScoreWeight) / float64(sumWeight)); got != *detail.Score {
		t.Errorf("weighted component average = %d, want score %d", got, *detail.Score)
	}
	if got := componentByName(t, detail.Components, "pressure").Inputs["avg_pressure_bar"]; got != 8 {
		t.Errorf("avg_pressure_bar = %v, want 8", got)
	}
	if got := componentByName(t, detail.Components, "duration").Inputs["seconds"]; got != 30 {
		t.Errorf("seconds = %v, want 30", got)
	}
	if got := componentByName(t, detail.Components, "channeling").Inputs["detected"]; got != 0 {
		t.Errorf("detected = %v, want 0", got)
	}
}

func TestCalcShotScoreDetail_ComponentsBeanRatioTarget(t *testing.T) {
	shot := fullScoreShot(300)
	bean := &Bean{BrewRatio: "1:2.5"}
	detail := CalcShotScoreDetail(shot, bean)
	ratio := componentByName(t, detail.Components, "ratio")
	if ratio.Target != "bean" {
		t.Errorf("ratio target = %q, want bean", ratio.Target)
	}
	if got := ratio.Inputs["target_ratio"]; got != 2.5 {
		t.Errorf("target_ratio = %v, want 2.5", got)
	}
}

func TestCalcShotScoreDetail_ComponentsProfileTempTarget(t *testing.T) {
	shot := fullScoreShot(300)
	shot["datapoints"].(map[string]any)["targetTemperature"] = mkPoints(900, 900, 900, 900, 900, 900)
	detail := CalcShotScoreDetail(shot, nil)
	temp := componentByName(t, detail.Components, "temperature")
	if temp.Target != "profile" {
		t.Errorf("temperature target = %q, want profile", temp.Target)
	}
	if got := temp.Inputs["target_temp_c"]; got != 90 {
		t.Errorf("target_temp_c = %v, want 90", got)
	}
}

func TestCalcShotScoreDetail_NilScoreHasNilComponents(t *testing.T) {
	if got := CalcShotScoreDetail(nil, nil).Components; got != nil {
		t.Errorf("nil-shot components = %v, want nil", got)
	}
	shot := Shot{
		"duration": 300.0,
		"datapoints": map[string]any{
			"pressure": mkPoints(80, 80, 80), // only 3 samples >= 5 bar
		},
	}
	if got := CalcShotScoreDetail(shot, nil).Components; got != nil {
		t.Errorf("insufficient-pressure components = %v, want nil", got)
	}
}
