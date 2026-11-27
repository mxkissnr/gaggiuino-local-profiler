// Package grindscale is a library grinder's optional grind scale (#1961): the
// valid settings of a stepped or stepless grinder, or of a multi-part dial
// (#2225: number.tick, rotation.number.click, number + letter). It is a leaf package because
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
	TypeDial     = "dial"

	maxSteppedValues = 500
	maxDialParts     = 3
	maxPartCount     = 100
	maxLetters       = 26
	maxPartStart     = 1000
	// referenceSpan is the dial the fixed advice numbers were sized for.
	referenceSpan = 50.0
	eps           = 1e-9
)

var (
	numberRe = regexp.MustCompile(`^\d+(?:[.,]\d+)?$`)
	// numberInTextRe finds the first number in a free-text setting.
	numberInTextRe = regexp.MustCompile(`\d+(?:[.,]\d+)?`)
)

// Scale is one grinder's valid settings. Min, Max and Step are linear
// positions: the setting itself on a stepped or stepless scale, a count of the
// smallest unit (tick, click) on a dial. Only Dial knows how a setting is
// written.
type Scale struct {
	Type           string
	Min, Max, Step float64
	Dial           *Dial
}

// Part is one part of a dial reading: the first counts up without end from
// Start, every later one has Count values, written as digits or letters.
type Part struct {
	Count  int
	Start  int
	Letter bool
}

// Dial is the notation of a multi-part dial (#2225). Min and Max are readings.
type Dial struct {
	Parts      []Part
	Min, Max   string
	Stepless   bool
	Resolution int
}

// Parse returns the scale raw describes, or nil when raw is not a valid one.
func Parse(raw any) *Scale {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	typ, _ := m["type"].(string)
	if typ == TypeDial {
		return parseDial(m)
	}
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

func parseDial(m map[string]any) *Scale {
	parts := parseParts(m["parts"])
	minText, okMin := m["min"].(string)
	maxText, okMax := m["max"].(string)
	if parts == nil || !okMin || !okMax {
		return nil
	}
	stepless := false
	if v, present := m["stepless"]; present {
		b, ok := v.(bool)
		if !ok {
			return nil
		}
		stepless = b
	}
	res := 1
	if v, present := m["resolution"]; present {
		r, ok := whole(v, 1, 4)
		if !ok || r == 3 {
			return nil
		}
		if stepless {
			res = r
		}
	}
	d := &Dial{Parts: parts, Stepless: stepless, Resolution: res}
	lo, okLo := d.parse(minText)
	hi, okHi := d.parse(maxText)
	if !okLo || !okHi || hi <= lo {
		return nil
	}
	d.Min, d.Max = d.format(lo), d.format(hi)
	return &Scale{Type: TypeDial, Min: lo, Max: hi, Step: 1 / float64(res), Dial: d}
}

func parseParts(raw any) []Part {
	list, ok := raw.([]any)
	if !ok || len(list) < 2 || len(list) > maxDialParts {
		return nil
	}
	parts := make([]Part, 0, len(list))
	for i, item := range list {
		p, ok := item.(map[string]any)
		if !ok {
			return nil
		}
		kind := "number"
		if labels, present := p["labels"]; present && labels != nil {
			kind, _ = labels.(string)
		}
		if i == 0 {
			count, hasCount := p["count"]
			if !hasCount || count != nil || kind != "number" {
				return nil
			}
			start := 0
			if v, present := p["start"]; present {
				if start, ok = whole(v, 0, maxPartStart); !ok {
					return nil
				}
			}
			parts = append(parts, Part{Start: start})
			continue
		}
		limit := maxPartCount
		switch kind {
		case "number":
		case "letter":
			limit = maxLetters
		default:
			return nil
		}
		count, ok := whole(p["count"], 2, limit)
		if !ok {
			return nil
		}
		parts = append(parts, Part{Count: count, Letter: kind == "letter"})
	}
	return parts
}

// Map is the stored form of s.
func (s *Scale) Map() map[string]any {
	if s.Dial == nil {
		return map[string]any{"type": s.Type, "min": s.Min, "max": s.Max, "step": s.Step}
	}
	parts := make([]any, len(s.Dial.Parts))
	for i, p := range s.Dial.Parts {
		if i == 0 {
			parts[i] = map[string]any{"count": nil, "start": float64(p.Start)}
			continue
		}
		labels := "number"
		if p.Letter {
			labels = "letter"
		}
		parts[i] = map[string]any{"count": float64(p.Count), "labels": labels}
	}
	return map[string]any{
		"type": TypeDial, "parts": parts, "min": s.Dial.Min, "max": s.Dial.Max,
		"stepless": s.Dial.Stepless, "resolution": float64(s.Dial.Resolution),
	}
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

// Position returns the position a stored setting names (#2225): through the
// dial when s is one, else the first number in the free text, as the grind
// advice always read it ("Setting 3.5" -> 3.5, "3,5" -> 3.5). A dial has no
// free-text fallback: "8.3" there is not the number 8.3. s may be nil.
func Position(s *Scale, setting string) (float64, bool) {
	if s != nil && s.Dial != nil {
		return s.Dial.parse(setting)
	}
	m := numberInTextRe.FindString(setting)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.Replace(m, ",", ".", 1), 64)
	return v, err == nil
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

// Normalize returns input in the one stored format, "" for an empty input, or
// an error when it is not a valid setting of this scale.
func (s *Scale) Normalize(input string) (string, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return "", nil
	}
	if v, ok := s.parse(text); ok && s.InRange(v) && math.Abs(v-s.Snap(v)) <= eps {
		return s.Format(s.Snap(v)), nil
	}
	if s.Dial != nil {
		return "", fmt.Errorf("must be a setting from %s to %s on this dial", s.Dial.Min, s.Dial.Max)
	}
	return "", fmt.Errorf("must be a number from %g to %g in steps of %g", s.Min, s.Max, s.Step)
}

// Format writes position v the way this scale reads: every stepped part, so
// 8.0 keeps its .0, and a stepless dial's fraction after a comma ("8.2,5").
func (s *Scale) Format(v float64) string {
	if s.Dial != nil {
		return s.Dial.format(v)
	}
	return strconv.FormatFloat(s.round(v), 'f', s.decimals(), 64)
}

// parse returns the position a setting names, ok=false when it is not one.
// Not range-checked.
func (s *Scale) parse(text string) (float64, bool) {
	if s.Dial != nil {
		return s.Dial.parse(text)
	}
	text = strings.TrimSpace(text)
	if !numberRe.MatchString(text) {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.Replace(text, ",", ".", 1), 64)
	return v, err == nil
}

// parse returns the position a dial reading names; ok=false for "8.7" on six
// ticks, a letter out of range or a fraction finer than the resolution.
func (d *Dial) parse(input string) (float64, bool) {
	text := strings.ToUpper(strings.TrimSpace(input))
	fraction := 0.0
	comma := strings.IndexByte(text, ',')
	if comma >= 0 {
		digits := text[comma+1:]
		if !d.Stepless || !allDigits(digits) {
			return 0, false
		}
		fraction, _ = strconv.ParseFloat("0."+digits, 64)
		text = text[:comma]
	}
	head := leadingDigits(text)
	if head == "" {
		return 0, false
	}
	first, _ := strconv.ParseFloat(head, 64)
	pos := first - float64(d.Parts[0].Start)
	if pos < 0 {
		return 0, false
	}
	rest := text[len(head):]
	for i, part := range d.Parts[1:] {
		value := 0.0
		switch {
		case part.Letter:
			if rest == "" {
				return 0, false
			}
			value = float64(int(rest[0]) - 'A')
			rest = rest[1:]
		case rest != "":
			if rest[0] != '.' {
				return 0, false
			}
			digits := leadingDigits(rest[1:])
			if digits == "" {
				return 0, false
			}
			rest = rest[1+len(digits):]
			// "8.25" on a stepless dial with six ticks is tick 2 and a half: "8.2,5".
			width := len(strconv.Itoa(part.Count - 1))
			if i == len(d.Parts)-2 && d.Stepless && comma < 0 && len(digits) > width {
				fraction, _ = strconv.ParseFloat("0."+digits[width:], 64)
				digits = digits[:width]
			}
			value, _ = strconv.ParseFloat(digits, 64)
		}
		if value < 0 || value >= float64(part.Count) {
			return 0, false
		}
		pos = pos*float64(part.Count) + value
	}
	if rest != "" {
		return 0, false
	}
	scaled := fraction * float64(d.Resolution)
	if fraction >= 1 || math.Abs(scaled-math.Round(scaled)) > eps {
		return 0, false
	}
	return pos + fraction, true
}

func (d *Dial) format(v float64) string {
	res := float64(d.Resolution)
	steps := math.Round(math.Max(0, v) * res)
	wholeSteps := math.Floor(steps / res)
	fraction := (steps - wholeSteps*res) / res
	n := int64(wholeSteps)
	tail := ""
	for i := len(d.Parts) - 1; i > 0; i-- {
		count := int64(d.Parts[i].Count)
		digit := n % count
		n /= count
		if d.Parts[i].Letter {
			tail = string(rune('A'+digit)) + tail
		} else {
			tail = "." + strconv.FormatInt(digit, 10) + tail
		}
	}
	out := strconv.FormatInt(n+int64(d.Parts[0].Start), 10) + tail
	if fraction > 0 {
		out += "," + strings.TrimPrefix(strconv.FormatFloat(fraction, 'f', -1, 64), "0.")
	}
	return out
}

func (s *Scale) last() float64 {
	return s.round(s.Min + math.Floor((s.Max-s.Min)/s.Step+eps)*s.Step)
}

func (s *Scale) round(v float64) float64 {
	p := math.Pow10(s.decimals())
	return math.Round(v*p) / p
}

func (s *Scale) decimals() int {
	return max(decimals(s.Min), decimals(s.Step))
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

func allDigits(s string) bool {
	return s != "" && leadingDigits(s) == s
}

func leadingDigits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}

// whole reads a JSON number (or a Go int) that must be an integer in lo..hi.
func whole(raw any, lo, hi int) (int, bool) {
	var v float64
	switch n := raw.(type) {
	case float64:
		v = n
	case int:
		v = float64(n)
	default:
		return 0, false
	}
	if v != math.Trunc(v) || v < float64(lo) || v > float64(hi) {
		return 0, false
	}
	return int(v), true
}

func finite(raw any) (float64, bool) {
	v, ok := raw.(float64)
	return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0)
}
