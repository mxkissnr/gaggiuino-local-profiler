package grindscale

import (
	"math"
	"testing"
)

func TestParse_Valid(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
		want Scale
	}{
		{"stepped", map[string]any{"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0}, Scale{TypeStepped, 0, 60, 1}},
		{"stepless", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.1}, Scale{TypeStepless, 0, 9, 0.1}},
		{"decimals in min", map[string]any{"type": "stepless", "min": 0.5, "max": 9.0, "step": 0.1}, Scale{TypeStepless, 0.5, 9, 0.1}},
		{"last span under the stepped cap", map[string]any{"type": "stepped", "min": 0.0, "max": 499.0, "step": 1.0}, Scale{TypeStepped, 0, 499, 1}},
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
		{"negative step", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": -0.1}},
		{"step larger than span", map[string]any{"type": "stepless", "min": 0.0, "max": 1.0, "step": 2.0}},
		{"four decimals in step", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.0001}},
		{"four decimals in min", map[string]any{"type": "stepless", "min": 0.0001, "max": 9.0, "step": 0.1}},
		{"stepped span of 500 values", map[string]any{"type": "stepped", "min": 0.0, "max": 500.0, "step": 1.0}},
		{"stepped span beyond 500 values", map[string]any{"type": "stepped", "min": 0.0, "max": 1000.0, "step": 1.0}},
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

func TestParse_SteplessSpanIsNotCapped(t *testing.T) {
	if got := Parse(map[string]any{"type": "stepless", "min": 0.0, "max": 1000.0, "step": 0.1}); got == nil {
		t.Fatal("a stepless dial has no 500-value cap")
	}
}

func TestMap_RoundTrips(t *testing.T) {
	original := &Scale{TypeStepped, 0, 60, 1}
	got := Parse(original.Map())
	if got == nil || *got != *original {
		t.Errorf("Parse(Map()) = %+v, want %+v", got, *original)
	}
}

func TestMap_Shape(t *testing.T) {
	m := (&Scale{TypeStepless, 0, 9, 0.1}).Map()
	if len(m) != 4 {
		t.Fatalf("Map() has %d keys, want 4: %#v", len(m), m)
	}
	if m["type"] != TypeStepless || m["min"] != 0.0 || m["max"] != 9.0 || m["step"] != 0.1 {
		t.Errorf("Map() = %#v", m)
	}
}
