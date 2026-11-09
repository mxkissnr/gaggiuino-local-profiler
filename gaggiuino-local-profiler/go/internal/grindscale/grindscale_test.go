package grindscale

import (
	"math"
	"strconv"
	"testing"
)

func stepped(step float64) map[string]any {
	return map[string]any{"type": "stepped", "min": 0.0, "max": 60.0, "step": step}
}

func stepless(minV, maxV, step float64) map[string]any {
	return map[string]any{"type": "stepless", "min": minV, "max": maxV, "step": step}
}

func TestParse_Valid(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
		want Scale
	}{
		{"stepped", map[string]any{"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0}, Scale{TypeStepped, 0, 60, 1}},
		{"stepless", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.1}, Scale{TypeStepless, 0, 9, 0.1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Parse(tc.raw)
			if got == nil {
				t.Fatalf("Parse(%v) = nil", tc.raw)
			}
			if *got != tc.want {
				t.Errorf("Parse = %+v, want %+v", *got, tc.want)
			}
		})
	}
}

func TestParse_Invalid(t *testing.T) {
	cases := []struct {
		name string
		raw  any
	}{
		{"not a map", "stepped"},
		{"nil", nil},
		{"unknown type", map[string]any{"type": "clicky", "min": 0.0, "max": 9.0, "step": 0.1}},
		{"missing type", map[string]any{"min": 0.0, "max": 9.0, "step": 0.1}},
		{"missing min", map[string]any{"type": "stepless", "max": 9.0, "step": 0.1}},
		{"missing max", map[string]any{"type": "stepless", "min": 0.0, "step": 0.1}},
		{"missing step", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0}},
		{"string number", map[string]any{"type": "stepless", "min": "0", "max": 9.0, "step": 0.1}},
		{"negative min", map[string]any{"type": "stepless", "min": -1.0, "max": 9.0, "step": 0.1}},
		{"max equals min", map[string]any{"type": "stepless", "min": 9.0, "max": 9.0, "step": 0.1}},
		{"max below min", map[string]any{"type": "stepless", "min": 9.0, "max": 0.0, "step": 0.1}},
		{"step zero", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.0}},
		{"step larger than span", map[string]any{"type": "stepless", "min": 0.0, "max": 1.0, "step": 2.0}},
		{"four decimals", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.0001}},
		{"500 stepped values", map[string]any{"type": "stepped", "min": 0.0, "max": 500.0, "step": 1.0}},
		{"NaN", map[string]any{"type": "stepless", "min": math.NaN(), "max": 9.0, "step": 0.1}},
		{"Inf", map[string]any{"type": "stepless", "min": 0.0, "max": math.Inf(1), "step": 0.1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Parse(tc.raw); got != nil {
				t.Errorf("Parse(%v) = %+v, want nil", tc.raw, *got)
			}
		})
	}
}

func TestSnap(t *testing.T) {
	casa := &Scale{TypeStepless, 0, 9, 0.1}
	cases := []struct {
		name  string
		scale *Scale
		in    float64
		want  float64
	}{
		{"round down", casa, 8.34, 8.3},
		{"round up", casa, 8.36, 8.4},
		{"below range", casa, -1, 0},
		{"above range", casa, 12, 9},
		{"last valid of a stepped dial", &Scale{TypeStepped, 0, 9.5, 2}, 9.4, 8},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.scale.Snap(tc.in); got != tc.want {
				t.Errorf("Snap(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestSnap_PrintsClean(t *testing.T) {
	casa := &Scale{TypeStepless, 0, 9, 0.1}
	if got := strconv.FormatFloat(casa.Snap(8.31), 'f', -1, 64); got != "8.3" {
		t.Errorf("Snap(8.31) formats as %q, want 8.3", got)
	}
}

func TestOnTarget(t *testing.T) {
	cases := []struct {
		name  string
		scale *Scale
		diff  float64
		want  bool
	}{
		{"stepped one step", &Scale{TypeStepped, 0, 60, 1}, 1, true},
		{"stepped two steps", &Scale{TypeStepped, 0, 60, 1}, 2, false},
		{"casa one step", &Scale{TypeStepless, 0, 9, 0.1}, 0.1, true},
		{"casa two steps", &Scale{TypeStepless, 0, 9, 0.1}, 0.2, false},
		{"50-mark dial keeps 0.6", &Scale{TypeStepless, 0, 50, 0.1}, 0.5, true},
		{"50-mark dial rejects 0.6", &Scale{TypeStepless, 0, 50, 0.1}, 0.6, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.scale.OnTarget(tc.diff); got != tc.want {
				t.Errorf("OnTarget(%v) = %v, want %v", tc.diff, got, tc.want)
			}
		})
	}
}

func TestNormalize(t *testing.T) {
	casa := &Scale{TypeStepless, 0, 9, 0.1}
	valid := []struct {
		in   string
		want string
	}{
		{"8,3", "8.3"},
		{"8.0", "8"},
		{"8.30", "8.3"},
		{"", ""},
		{" 8.3 ", "8.3"},
	}
	for _, tc := range valid {
		t.Run("valid "+tc.in, func(t *testing.T) {
			got, err := casa.Normalize(tc.in)
			if err != nil {
				t.Fatalf("Normalize(%q) error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}

	invalid := []string{"9.1", "8.35", "abc", "1.2.3", "8 clicks"}
	for _, in := range invalid {
		t.Run("invalid "+in, func(t *testing.T) {
			if got, err := casa.Normalize(in); err == nil {
				t.Errorf("Normalize(%q) = %q, want an error", in, got)
			}
		})
	}
}

func TestForGrinder(t *testing.T) {
	grinders := []map[string]any{
		{"name": "Kingrinder K6", "scale": stepped(1)},
		{"name": "  Lagom Casa  ", "scale": stepless(0, 9, 0.1)},
		{"name": "Broken", "scale": map[string]any{"type": "stepped"}},
		{"name": "No Scale"},
	}

	if got := ForGrinder(grinders, "kingrinder k6"); got == nil || got.Type != TypeStepped {
		t.Errorf("ForGrinder(case-insensitive) = %+v", got)
	}
	if got := ForGrinder(grinders, " Lagom Casa "); got == nil || got.Step != 0.1 {
		t.Errorf("ForGrinder(trimmed) = %+v", got)
	}
	for _, name := range []string{"Unknown", "", "   "} {
		if got := ForGrinder(grinders, name); got != nil {
			t.Errorf("ForGrinder(%q) = %+v, want nil", name, *got)
		}
	}
	if got := ForGrinder(grinders, "Broken"); got != nil {
		t.Errorf("ForGrinder(garbage scale) = %+v, want nil", *got)
	}
}

func TestMap_RoundTrips(t *testing.T) {
	original := &Scale{TypeStepped, 0, 60, 1}
	got := Parse(original.Map())
	if got == nil || *got != *original {
		t.Errorf("Parse(Map()) = %+v, want %+v", got, *original)
	}
}

func TestInRange(t *testing.T) {
	casa := &Scale{TypeStepless, 0, 9, 0.1}
	for _, v := range []float64{0, 4.5, 9} {
		if !casa.InRange(v) {
			t.Errorf("InRange(%v) = false, want true", v)
		}
	}
	for _, v := range []float64{-0.1, 9.1} {
		if casa.InRange(v) {
			t.Errorf("InRange(%v) = true, want false", v)
		}
	}
}
