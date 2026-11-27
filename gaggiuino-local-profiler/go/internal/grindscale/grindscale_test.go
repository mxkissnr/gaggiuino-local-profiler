package grindscale

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestParse_Valid(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
		want Scale
	}{
		{"stepped", map[string]any{"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0}, Scale{TypeStepped, 0, 60, 1, nil}},
		{"stepless", map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.1}, Scale{TypeStepless, 0, 9, 0.1, nil}},
		{"decimals in min", map[string]any{"type": "stepless", "min": 0.5, "max": 9.0, "step": 0.1}, Scale{TypeStepless, 0.5, 9, 0.1, nil}},
		{"last span under the stepped cap", map[string]any{"type": "stepped", "min": 0.0, "max": 499.0, "step": 1.0}, Scale{TypeStepped, 0, 499, 1, nil}},
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
	original := &Scale{TypeStepped, 0, 60, 1, nil}
	got := Parse(original.Map())
	if got == nil || *got != *original {
		t.Errorf("Parse(Map()) = %+v, want %+v", got, *original)
	}
}

func TestMap_Shape(t *testing.T) {
	m := (&Scale{TypeStepless, 0, 9, 0.1, nil}).Map()
	if len(m) != 4 {
		t.Fatalf("Map() has %d keys, want 4: %#v", len(m), m)
	}
	if m["type"] != TypeStepless || m["min"] != 0.0 || m["max"] != 9.0 || m["step"] != 0.1 {
		t.Errorf("Map() = %#v", m)
	}
}

// #2225: multi-part dials. Mirrors the dial cases in test/grind-scale.test.ts.

func mustDial(t *testing.T, raw map[string]any) *Scale {
	t.Helper()
	s := Parse(raw)
	if s == nil {
		t.Fatalf("Parse(%v) = nil, want a dial scale", raw)
	}
	return s
}

func ringScale(t *testing.T, resolution float64) *Scale {
	return mustDial(t, map[string]any{"type": "dial", "parts": []any{
		map[string]any{"count": nil, "start": 0.0}, map[string]any{"count": 6.0, "labels": "number"},
	}, "min": "0.0", "max": "12.5", "stepless": true, "resolution": resolution})
}

func rotationScale(t *testing.T) *Scale {
	return mustDial(t, map[string]any{"type": "dial", "parts": []any{
		map[string]any{"count": nil}, map[string]any{"count": 10.0}, map[string]any{"count": 10.0},
	}, "min": "0.0.0", "max": "4.9.9"})
}

func setteScale(t *testing.T) *Scale {
	return mustDial(t, map[string]any{"type": "dial", "parts": []any{
		map[string]any{"count": nil, "start": 1.0}, map[string]any{"count": 9.0, "labels": "letter"},
	}, "min": "1A", "max": "31I"})
}

// next is the setting one smallest unit after setting.
func next(t *testing.T, s *Scale, setting string) string {
	t.Helper()
	v, ok := s.parse(setting)
	if !ok {
		t.Fatalf("parse(%q) failed", setting)
	}
	return s.Format(s.Snap(v + 1))
}

func normalized(s *Scale, input string) string {
	out, err := s.Normalize(input)
	if err != nil {
		return "<invalid>"
	}
	return out
}

func TestDial_ReadsPositionsInTheSmallestUnit(t *testing.T) {
	ring := ringScale(t, 2)
	if ring.Min != 0 || ring.Max != 77 || ring.Step != 0.5 {
		t.Errorf("ring = %+v, want positions 0..77 in steps of 0.5", *ring)
	}
	if s := rotationScale(t); s.Min != 0 || s.Max != 499 || s.Step != 1 {
		t.Errorf("rotation = %+v, want positions 0..499", *s)
	}
	if s := setteScale(t); s.Min != 0 || s.Max != 278 || s.Step != 1 {
		t.Errorf("sette = %+v, want positions 0..278", *s)
	}
	if v, ok := ring.parse("8.3,5"); !ok || v != 51.5 {
		t.Errorf("parse(8.3,5) = %v, %v, want 51.5", v, ok)
	}
}

func TestDial_RejectsBrokenScales(t *testing.T) {
	parts := []any{map[string]any{"count": nil}, map[string]any{"count": 6.0}}
	for _, raw := range []map[string]any{
		{"type": "dial", "parts": []any{map[string]any{"count": nil}}, "min": "0", "max": "9"},
		{"type": "dial", "parts": []any{map[string]any{"count": 6.0}, map[string]any{"count": 6.0}}, "min": "0.0", "max": "9.5"},
		{"type": "dial", "parts": []any{map[string]any{"count": nil}, map[string]any{"count": 1.0}}, "min": "0.0", "max": "9.0"},
		{"type": "dial", "parts": []any{map[string]any{"count": nil}, map[string]any{"count": 27.0, "labels": "letter"}}, "min": "0A", "max": "9A"},
		{"type": "dial", "parts": parts, "min": "9.0", "max": "0.0"},
		{"type": "dial", "parts": parts, "min": "0.0", "max": "9.6"},
		{"type": "dial", "parts": parts, "min": 0.0, "max": 9.0},
		{"type": "dial", "parts": parts, "min": "0.0", "max": "9.0", "stepless": true, "resolution": 3.0},
	} {
		if got := Parse(raw); got != nil {
			t.Errorf("Parse(%v) = %+v, want nil", raw, *got)
		}
	}
}

func TestDial_RingStepsTickByTick(t *testing.T) {
	ring := ringScale(t, 2)
	if got := next(t, ring, "8.5"); got != "9.0" {
		t.Errorf("next after 8.5 = %q, want 9.0", got)
	}
	for _, in := range []string{"8.6", "8.7", "12.6"} {
		if got := normalized(ring, in); got != "<invalid>" {
			t.Errorf("Normalize(%q) = %q, want an error", in, got)
		}
	}
	for in, want := range map[string]string{"8.25": "8.2,5", "8.2,5": "8.2,5", "8": "8.0", "8.0": "8.0"} {
		if got := normalized(ring, in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDial_HonoursTheResolution(t *testing.T) {
	half, quarter := ringScale(t, 2), ringScale(t, 4)
	if got := normalized(half, "8.2,25"); got != "<invalid>" {
		t.Errorf("half ticks: Normalize(8.2,25) = %q, want an error", got)
	}
	if got := normalized(quarter, "8.2,25"); got != "8.2,25" {
		t.Errorf("quarter ticks: Normalize(8.2,25) = %q, want 8.2,25", got)
	}
	if got := half.Snap(49.3); got != 49.5 {
		t.Errorf("half Snap(49.3) = %v, want 49.5", got)
	}
	if got := quarter.Snap(49.3); got != 49.25 {
		t.Errorf("quarter Snap(49.3) = %v, want 49.25", got)
	}
	if got := normalized(rotationScale(t), "1.2.3,5"); got != "<invalid>" {
		t.Errorf("stepped dial: Normalize(1.2.3,5) = %q, want an error", got)
	}
}

func TestDial_RotationCarriesIntoTheNextRotation(t *testing.T) {
	rotation := rotationScale(t)
	if got := next(t, rotation, "1.9.9"); got != "2.0.0" {
		t.Errorf("next after 1.9.9 = %q, want 2.0.0", got)
	}
	if got := normalized(rotation, "1.2"); got != "1.2.0" {
		t.Errorf("Normalize(1.2) = %q, want 1.2.0", got)
	}
}

func TestDial_LetterCarriesIntoTheNextNumber(t *testing.T) {
	sette := setteScale(t)
	if got := next(t, sette, "12I"); got != "13A" {
		t.Errorf("next after 12I = %q, want 13A", got)
	}
	if got := normalized(sette, "12e"); got != "12E" {
		t.Errorf("Normalize(12e) = %q, want 12E", got)
	}
	for _, in := range []string{"12J", "0I", "12"} {
		if got := normalized(sette, in); got != "<invalid>" {
			t.Errorf("Normalize(%q) = %q, want an error", in, got)
		}
	}
}

func TestDial_InBetweenSortsBetweenTicks(t *testing.T) {
	ring := ringScale(t, 2)
	a, _ := ring.parse("8.3")
	b, _ := ring.parse("8.3,5")
	c, _ := ring.parse("8.4")
	if !(a < b && b < c) {
		t.Errorf("positions 8.3=%v 8.3,5=%v 8.4=%v, want strictly increasing", a, b, c)
	}
}

func TestDial_MapRoundTripsThroughJSON(t *testing.T) {
	for _, original := range []*Scale{ringScale(t, 2), rotationScale(t), setteScale(t)} {
		blob, err := json.Marshal(original.Map())
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]any
		if err := json.Unmarshal(blob, &raw); err != nil {
			t.Fatal(err)
		}
		got := Parse(raw)
		if got == nil || !reflect.DeepEqual(got, original) {
			t.Errorf("Parse(JSON(Map())) = %+v, want %+v (json %s)", got, original, blob)
		}
	}
	m := ringScale(t, 2).Map()
	if m["min"] != "0.0" || m["max"] != "12.5" || m["stepless"] != true || m["resolution"] != 2.0 {
		t.Errorf("Map() = %#v, want the readings and the resolution", m)
	}
}

func TestNormalize_KeepsTrailingZero(t *testing.T) {
	stepless := &Scale{Type: TypeStepless, Min: 0, Max: 9, Step: 0.1}
	if got := normalized(stepless, "8.0"); got != "8.0" {
		t.Errorf("stepless Normalize(8.0) = %q, want 8.0", got)
	}
	if got := normalized(stepless, "8"); got != "8.0" {
		t.Errorf("stepless Normalize(8) = %q, want 8.0", got)
	}
	stepped := &Scale{Type: TypeStepped, Min: 0, Max: 60, Step: 1}
	if got := normalized(stepped, "33"); got != "33" {
		t.Errorf("stepped Normalize(33) = %q, want 33", got)
	}
}

func TestPosition_ReadsThroughTheScaleFirst(t *testing.T) {
	if v, ok := Position(nil, "Setting 3.5"); !ok || v != 3.5 {
		t.Errorf("Position(nil, Setting 3.5) = %v, %v, want 3.5", v, ok)
	}
	if v, ok := Position(nil, "8.2,5"); !ok || v != 8.2 {
		t.Errorf("Position(nil, 8.2,5) = %v, %v, want the old 8.2 without a scale", v, ok)
	}
	stepless := &Scale{Type: TypeStepless, Min: 0, Max: 9, Step: 0.1}
	if v, ok := Position(stepless, "8 clicks"); !ok || v != 8 {
		t.Errorf("Position(stepless, 8 clicks) = %v, %v, want 8", v, ok)
	}
	ring := ringScale(t, 2)
	if v, ok := Position(ring, "8.3,5"); !ok || v != 51.5 {
		t.Errorf("Position(ring, 8.3,5) = %v, %v, want 51.5", v, ok)
	}
	if _, ok := Position(ring, "Setting 8.3"); ok {
		t.Error("Position(ring, Setting 8.3) read a dial setting from free text")
	}
}
