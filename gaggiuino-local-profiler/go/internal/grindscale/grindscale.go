// Package grindscale is a library grinder's optional grind scale (#1961): the
// valid settings of a stepped or stepless grinder. It is a leaf package because
// internal/library and internal/shots both need it and library imports shots.
// public-src/grind-scale.ts is the browser's copy; keep the two in step.
//
// This slice only validates and stores a scale. Snapping a setting, judging
// whether a shot is on target and normalising typed input arrive with the
// grind-advice slice that calls them, so no function here is unreachable from
// the production binary (CI's deadcode gate).
package grindscale

import "math"

const (
	TypeStepped  = "stepped"
	TypeStepless = "stepless"

	maxSteppedValues = 500
)

// Scale is one grinder's valid settings.
type Scale struct {
	Type           string
	Min, Max, Step float64
}

// Parse returns the scale raw describes, or nil when raw is not a valid one.
func Parse(raw any) *Scale {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	typ, _ := m["type"].(string)
	minV, okMin := finite(m["min"])
	maxV, okMax := finite(m["max"])
	step, okStep := finite(m["step"])
	if (typ != TypeStepped && typ != TypeStepless) || !okMin || !okMax || !okStep {
		return nil
	}
	if minV < 0 || maxV <= minV || step <= 0 || step > maxV-minV {
		return nil
	}
	if !fitsDecimals(minV) || !fitsDecimals(maxV) || !fitsDecimals(step) {
		return nil
	}
	if typ == TypeStepped && (maxV-minV)/step >= maxSteppedValues {
		return nil
	}
	return &Scale{Type: typ, Min: minV, Max: maxV, Step: step}
}

// Map is the stored form of s.
func (s *Scale) Map() map[string]any {
	return map[string]any{"type": s.Type, "min": s.Min, "max": s.Max, "step": s.Step}
}

// fitsDecimals rejects a value with more than three decimals: a stored scale is
// a dial reading, and step/min/max allow at most three decimals.
func fitsDecimals(v float64) bool {
	r := v * 1000
	return math.Abs(r-math.Round(r)) < 1e-6
}

func finite(raw any) (float64, bool) {
	v, ok := raw.(float64)
	return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0)
}
