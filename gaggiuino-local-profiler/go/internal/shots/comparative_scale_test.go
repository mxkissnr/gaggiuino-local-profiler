package shots

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/grindscale"
)

// steplessScale and steppedScale are the two dials these tests run on.
func steplessScale(min, max, step float64) *grindscale.Scale {
	return &grindscale.Scale{Type: grindscale.TypeStepless, Min: min, Max: max, Step: step}
}

func steppedScale(max, step float64) *grindscale.Scale {
	return &grindscale.Scale{Type: grindscale.TypeStepped, Min: 0, Max: max, Step: step}
}

// TestComparativeAdvice_UsesTheGrindersStep is the issue's own case: 8.4 on a
// stepless dial is a valid setting and must not be rounded to 8.5.
func TestComparativeAdvice_UsesTheGrindersStep(t *testing.T) {
	m := newComparativeMatch(comparableShot(1, "Kenya AA", "Lagom", "8.4", 18, "Espresso"))
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	siblings := []comparableSibling{{grind: 8.4, score: 90}}

	m.scale = steplessScale(0, 9, 0.1)
	advice := m.advice(siblings, "en")
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.BestGrindSetting != 8.4 {
		t.Errorf("BestGrindSetting = %v, want 8.4 on the grinder's scale", advice.BestGrindSetting)
	}

	m.scale = nil
	advice = m.advice(siblings, "en")
	if advice == nil {
		t.Fatal("expected non-nil advice without a scale")
	}
	if advice.BestGrindSetting != 8.5 {
		t.Errorf("BestGrindSetting = %v, want the old 8.5 without a scale", advice.BestGrindSetting)
	}
}

func TestComparativeAdvice_SteppedKeepsWholeSettings(t *testing.T) {
	m := newComparativeMatch(comparableShot(1, "Kenya AA", "K6", "33", 18, "Espresso"))
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	m.scale = steppedScale(60, 1)

	advice := m.advice([]comparableSibling{
		{grind: 33, score: 40},
		{grind: 35, score: 90},
	}, "en")
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.BestGrindSetting != 35 {
		t.Errorf("BestGrindSetting = %v, want 35", advice.BestGrindSetting)
	}
	if advice.Type != "coarser" {
		t.Errorf("Type = %q, want coarser for 33 against 35", advice.Type)
	}
}

func TestComparativeAdvice_ScaleTolerance(t *testing.T) {
	cases := []struct {
		name    string
		current string
		want    string
	}{
		{"one step is on target", "8.4", "ok"},
		{"two steps asks for finer", "8.5", "finer"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newComparativeMatch(comparableShot(1, "Kenya AA", "Lagom", tc.current, 18, "Espresso"))
			if m == nil {
				t.Fatal("newComparativeMatch returned nil")
			}
			m.scale = steplessScale(0, 9, 0.1)
			advice := m.advice([]comparableSibling{{grind: 8.3, score: 90}}, "en")
			if advice == nil {
				t.Fatal("expected non-nil advice")
			}
			if advice.Type != tc.want {
				t.Errorf("Type = %q, want %q", advice.Type, tc.want)
			}
		})
	}
}

func TestComparativeAdvice_DropsSiblingsOutsideTheScale(t *testing.T) {
	m := newComparativeMatch(comparableShot(1, "Kenya AA", "Lagom", "8.0", 18, "Espresso"))
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	m.scale = steplessScale(0, 9, 0.1)

	advice := m.advice([]comparableSibling{
		{grind: 12, score: 100},
		{grind: 8.2, score: 50},
	}, "en")
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.BestGrindSetting != 8.2 {
		t.Errorf("BestGrindSetting = %v, want 8.2; the out-of-range 12 must not win", advice.BestGrindSetting)
	}
	if advice.SampleCount != 1 {
		t.Errorf("SampleCount = %d, want 1 after dropping the out-of-range sibling", advice.SampleCount)
	}

	if advice := m.advice([]comparableSibling{{grind: 12, score: 100}}, "en"); advice != nil {
		t.Errorf("expected nil advice when the only sibling is out of range, got %+v", *advice)
	}
}

func TestComparativeMatch_ReadsTheInstalledScaleSource(t *testing.T) {
	SetGrinderScaleSource(func(grinder string) *grindscale.Scale {
		if grinder == "lagom" {
			return steplessScale(0, 9, 0.1)
		}
		return nil
	})
	t.Cleanup(func() { SetGrinderScaleSource(nil) })

	m := newComparativeMatch(comparableShot(1, "Kenya AA", "Lagom", "8.4", 18, "Espresso"))
	if m == nil || m.scale == nil {
		t.Fatal("expected the installed source's scale")
	}
	if m.scale.Step != 0.1 {
		t.Errorf("scale.Step = %v, want 0.1", m.scale.Step)
	}

	other := newComparativeMatch(comparableShot(1, "Kenya AA", "Niche", "8.4", 18, "Espresso"))
	if other == nil {
		t.Fatal("newComparativeMatch returned nil for the unscaled grinder")
	}
	if other.scale != nil {
		t.Errorf("scale = %+v, want nil for a grinder the source knows nothing about", *other.scale)
	}

	SetGrinderScaleSource(nil)
	noSource := newComparativeMatch(comparableShot(1, "Kenya AA", "Lagom", "8.4", 18, "Espresso"))
	if noSource == nil {
		t.Fatal("newComparativeMatch returned nil without a source")
	}
	if noSource.scale != nil {
		t.Errorf("scale = %+v, want nil with no source installed", *noSource.scale)
	}
}

func TestComparativeAdvice_EqualSettingsShareABucket(t *testing.T) {
	m := newComparativeMatch(comparableShot(1, "Kenya AA", "Lagom", "8", 18, "Espresso"))
	if m == nil {
		t.Fatal("newComparativeMatch returned nil")
	}
	m.scale = steplessScale(0, 9, 0.5)

	advice := m.advice([]comparableSibling{
		{grind: 8, score: 70},
		{grind: 8.0, score: 90},
	}, "en")
	if advice == nil {
		t.Fatal("expected non-nil advice")
	}
	if advice.SampleCount != 2 {
		t.Errorf("SampleCount = %d, want 2", advice.SampleCount)
	}
	if advice.BestGrindSetting != 8 {
		t.Errorf("BestGrindSetting = %v, want the single bucket 8", advice.BestGrindSetting)
	}
	if advice.BestScore != 80 {
		t.Errorf("BestScore = %d, want 80 for the two averaged scores", advice.BestScore)
	}
}
