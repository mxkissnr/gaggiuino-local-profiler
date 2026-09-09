package shots

import "testing"

func TestParseGrindNum(t *testing.T) {
	cases := []struct {
		in     string
		want   float64
		wantOK bool
	}{
		{"", 0, false},
		{"3.5", 3.5, true},
		{"Setting 3.5", 3.5, true},
		{"3,5", 3.5, true},
		{"no digits here", 0, false},
		{"12", 12, true},
	}
	for _, c := range cases {
		got, ok := parseGrindNum(c.in)
		if ok != c.wantOK || (ok && got != c.want) {
			t.Errorf("parseGrindNum(%q) = %v, %v, want %v, %v", c.in, got, ok, c.want, c.wantOK)
		}
	}
}

// comparableShot builds a fullScoreShot (score.go's own test helper — a
// shot that always scores exactly 100) with the id/annotation/profileName/
// machineId fields ComputeComparativeGrindAdvice actually reads.
func comparableShot(id int64, coffee, grinder, grindSetting string, dose float64, profileName string) Shot {
	s := fullScoreShot(300)
	s["id"] = id
	s["machineId"] = int64(1)
	s["profileName"] = profileName
	ann, _ := s["annotation"].(map[string]any)
	ann["coffee"] = coffee
	ann["grinder"] = grinder
	ann["grindSetting"] = grindSetting
	ann["dose"] = dose
	s["annotation"] = ann
	return s
}

func TestComputeComparativeGrindAdvice_NoCoffeeOrGrinder(t *testing.T) {
	shot := comparableShot(1, "", "", "3.0", 18, "Espresso")
	if advice := ComputeComparativeGrindAdvice(shot, nil); advice != nil {
		t.Errorf("expected nil advice with no coffee/grinder set, got %+v", advice)
	}
}

func TestComputeComparativeGrindAdvice_NoComparableShots(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso")
	if advice := ComputeComparativeGrindAdvice(shot, []Shot{shot}); advice != nil {
		t.Errorf("expected nil advice with only itself in allShots, got %+v", advice)
	}
}

// TestComputeComparativeGrindAdvice_FinerAdvice: the current shot's grind
// (5.0) is coarser than the best-scoring comparable bucket (3.0), so the
// advice must say "grind finer" — diff = currentGrind - bestSetting > 0.
func TestComputeComparativeGrindAdvice_FinerAdvice(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "5.0", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso"),
		comparableShot(3, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso"),
	}
	advice := ComputeComparativeGrindAdvice(shot, others)
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.Type != "finer" {
		t.Errorf("Type = %q, want finer", advice.Type)
	}
	if advice.BestGrindSetting != 3.0 {
		t.Errorf("BestGrindSetting = %v, want 3.0", advice.BestGrindSetting)
	}
	if advice.SampleCount != 2 {
		t.Errorf("SampleCount = %d, want 2", advice.SampleCount)
	}
}

// TestComputeComparativeGrindAdvice_CoarserAdvice: the mirror case — current
// grind (2.0) is finer than the best bucket (4.0), diff < 0 -> "coarser".
func TestComputeComparativeGrindAdvice_CoarserAdvice(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "2.0", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Niche Zero", "4.0", 18, "Espresso"),
	}
	advice := ComputeComparativeGrindAdvice(shot, others)
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.Type != "coarser" {
		t.Errorf("Type = %q, want coarser", advice.Type)
	}
}

// TestComputeComparativeGrindAdvice_OkWhenCurrentGrindClose: within 0.6 of
// the best bucket counts as "ok", not finer/coarser.
func TestComputeComparativeGrindAdvice_OkWhenCurrentGrindClose(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "3.2", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso"),
	}
	advice := ComputeComparativeGrindAdvice(shot, others)
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.Type != "ok" {
		t.Errorf("Type = %q, want ok", advice.Type)
	}
}

// TestComputeComparativeGrindAdvice_OkWhenNoCurrentGrindSetting: the
// current shot has no parseable grindSetting of its own — advice still
// reports the best comparable bucket, as "ok" (no direction to suggest).
func TestComputeComparativeGrindAdvice_OkWhenNoCurrentGrindSetting(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso"),
	}
	advice := ComputeComparativeGrindAdvice(shot, others)
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.Type != "ok" {
		t.Errorf("Type = %q, want ok", advice.Type)
	}
}

// TestComputeComparativeGrindAdvice_ExcludesDifferentGrinderOrProfile
// verifies the comparable-shot filters: a shot on a different grinder or a
// different profile must not count.
func TestComputeComparativeGrindAdvice_ExcludesDifferentGrinderOrProfile(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "5.0", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Other Grinder", "3.0", 18, "Espresso"),
		comparableShot(3, "Kenya AA", "Niche Zero", "3.0", 18, "Filter"),
	}
	if advice := ComputeComparativeGrindAdvice(shot, others); advice != nil {
		t.Errorf("expected nil advice (no shots share grinder+profile), got %+v", advice)
	}
}

// TestComputeComparativeGrindAdvice_ExcludesDoseMismatch verifies the >1g
// dose-tolerance filter.
func TestComputeComparativeGrindAdvice_ExcludesDoseMismatch(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "5.0", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Niche Zero", "3.0", 21, "Espresso"), // 3g off -> excluded
	}
	if advice := ComputeComparativeGrindAdvice(shot, others); advice != nil {
		t.Errorf("expected nil advice (dose mismatch), got %+v", advice)
	}
}

// TestComputeComparativeGrindAdvice_BeanIDTakesPrecedenceOverName pins the
// #456 convention: a beanId match wins even when the coffee name string
// differs (a renamed bean), and a beanId MISMATCH excludes a shot even when
// the coffee name string happens to match (e.g. a reused/duplicate name).
func TestComputeComparativeGrindAdvice_BeanIDTakesPrecedenceOverName(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "5.0", 18, "Espresso")
	shot["annotation"].(map[string]any)["beanId"] = int64(42)

	renamedButSameBean := comparableShot(2, "Kenya AA (renamed)", "Niche Zero", "3.0", 18, "Espresso")
	renamedButSameBean["annotation"].(map[string]any)["beanId"] = int64(42)

	sameNameDifferentBean := comparableShot(3, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso")
	sameNameDifferentBean["annotation"].(map[string]any)["beanId"] = int64(99)

	advice := ComputeComparativeGrindAdvice(shot, []Shot{renamedButSameBean, sameNameDifferentBean})
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.SampleCount != 1 {
		t.Errorf("SampleCount = %d, want 1 (only the beanId match)", advice.SampleCount)
	}
}

// TestComputeComparativeGrindAdvice_TiedAverageIsDeterministic pins the
// #901 code review fix (CONFIRMED finding #3): two grind-setting buckets
// with the exact same average score (every comparableShot here scores
// a flat 100 via fullScoreShot, so a 3.0-only bucket and a 5.0-only bucket
// tie exactly) used to pick "best" via unsorted map iteration — Go
// randomizes that order per run, so the same shot could recommend a
// different grind setting across repeated calls. Calling this many times
// (each a fresh internal map) must always return the same answer — the
// documented tiebreak, the lower/finer grind setting wins ties.
func TestComputeComparativeGrindAdvice_TiedAverageIsDeterministic(t *testing.T) {
	shot := comparableShot(1, "Kenya AA", "Niche Zero", "4.0", 18, "Espresso")
	others := []Shot{
		comparableShot(2, "Kenya AA", "Niche Zero", "5.0", 18, "Espresso"),
		comparableShot(3, "Kenya AA", "Niche Zero", "3.0", 18, "Espresso"),
	}

	var first *ComparativeGrindAdvice
	for i := 0; i < 50; i++ {
		advice := ComputeComparativeGrindAdvice(shot, others)
		if advice == nil {
			t.Fatal("expected non-nil advice")
		}
		if first == nil {
			first = advice
			continue
		}
		if advice.BestGrindSetting != first.BestGrindSetting {
			t.Fatalf("run %d: BestGrindSetting = %v, want %v (same as the first run — tied-average pick must be deterministic)", i, advice.BestGrindSetting, first.BestGrindSetting)
		}
	}
	if first.BestGrindSetting != 3.0 {
		t.Errorf("BestGrindSetting = %v, want 3.0 (the documented tiebreak: lower grind setting wins an exact tie)", first.BestGrindSetting)
	}
}
