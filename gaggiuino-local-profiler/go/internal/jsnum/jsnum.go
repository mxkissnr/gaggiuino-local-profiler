// Package jsnum mirrors JavaScript's parseInt/parseFloat so values the
// frontend sends parse the same way server-side.
package jsnum

import (
	"regexp"
	"strconv"
	"strings"
)

// leadingFloatRe matches the longest leading float literal, the way JS's
// parseFloat stops at the first character that can't extend the number.
var leadingFloatRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`)

// ParseInt implements JS's parseInt(s, 10): skip leading JS whitespace, an
// optional sign, then consume leading decimal digits ("123abc" -> 123, ok);
// no digits at all is not ok ("abc").
func ParseInt(s string) (int64, bool) {
	i, n := 0, len(s)
	for i < n {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			i++
			continue
		}
		break
	}
	start := i
	if i < n && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digitsStart := i
	for i < n && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == digitsStart {
		return 0, false
	}
	v, err := strconv.ParseInt(s[start:i], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// ParseIntAny handles both a JSON-decoded number (float64) and a string
// query/body value: callers pass either shape depending on whether the value
// came from a body field or a query param.
func ParseIntAny(v any) (int64, bool) {
	switch t := v.(type) {
	case nil:
		return 0, false
	case string:
		if t == "" {
			return 0, false
		}
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case int:
		return int64(t), true
	default:
		return 0, false
	}
}

// ParseFloat implements JS's parseFloat(v): a number is returned as-is (NaN is
// not ok), an integer is widened, a string is parsed against its longest
// leading float literal ("12.5abc" -> 12.5, ok); anything else is not ok.
func ParseFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		if t != t { // NaN
			return 0, false
		}
		return t, true
	case int:
		return float64(t), true
	case string:
		trimmed := strings.TrimLeft(t, " \t\n\r\v\f")
		m := leadingFloatRe.FindString(trimmed)
		if m == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(m, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}
