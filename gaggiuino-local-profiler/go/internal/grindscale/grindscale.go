// Package grindscale is a library grinder's optional grind scale (#1961): the
// valid settings of a stepped or stepless grinder. It is a leaf package because
// internal/library and internal/shots both need it and library imports shots.
// public-src/grind-scale.ts is the browser's copy; keep the two in step.
package grindscale

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	TypeStepped  = "stepped"
	TypeStepless = "stepless"

	maxSteppedValues = 500
	// referenceSpan is the dial the fixed advice numbers were sized for.
	referenceSpan = 50.0
	eps           = 1e-9
)

var numberRe = regexp.MustCompile(`^\d+(?:[.,]\d+)?$`)

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

// ForGrinder returns the scale of the named grinder, nil when it has none.
func ForGrinder(grinders []map[string]any, name string) *Scale {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	for _, g := range grinders {
		if n, _ := g["name"].(string); strings.EqualFold(strings.TrimSpace(n), name) {
			return Parse(g["scale"])
		}
	}
	return nil
}

// InRange reports whether v lies within the scale's range.
func (s *Scale) InRange(v float64) bool { return v >= s.Min && v <= s.Max }

// Snap returns the valid setting nearest to v.
func (s *Scale) Snap(v float64) float64 {
	if v <= s.Min {
		return s.Min
	}
	if last := s.last(); v >= last {
		return last
	}
	return s.round(s.Min + math.Round((v-s.Min)/s.Step)*s.Step)
}

// OnTarget reports whether a difference from the best setting is small enough
// to leave alone: about one step, and never less than the old 0.6 scaled to
// this dial.
func (s *Scale) OnTarget(diff float64) bool {
	return math.Abs(diff) < math.Max(1.2*s.Step, 0.6*(s.Max-s.Min)/referenceSpan)
}

// Normalize returns input in the one stored number format, "" for an empty
// input, or an error when it is not a valid setting of this scale.
func (s *Scale) Normalize(input string) (string, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return "", nil
	}
	if numberRe.MatchString(text) {
		v, err := strconv.ParseFloat(strings.Replace(text, ",", ".", 1), 64)
		if err == nil && s.InRange(v) && math.Abs(v-s.Snap(v)) <= eps {
			return strconv.FormatFloat(s.Snap(v), 'f', -1, 64), nil
		}
	}
	return "", fmt.Errorf("must be a number from %g to %g in steps of %g", s.Min, s.Max, s.Step)
}

func (s *Scale) last() float64 {
	return s.round(s.Min + math.Floor((s.Max-s.Min)/s.Step+eps)*s.Step)
}

func (s *Scale) round(v float64) float64 {
	p := math.Pow10(max(decimals(s.Min), decimals(s.Step)))
	return math.Round(v*p) / p
}

func decimals(v float64) int {
	text := strconv.FormatFloat(v, 'f', -1, 64)
	if i := strings.IndexByte(text, '.'); i >= 0 {
		return len(text) - i - 1
	}
	return 0
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
