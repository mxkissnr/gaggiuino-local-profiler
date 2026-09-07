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
