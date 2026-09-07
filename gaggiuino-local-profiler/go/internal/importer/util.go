package importer

import (
	"regexp"
	"strconv"
	"strings"
)

// small shared conversion helpers used by handlers.go's size-variant
// projection and the duplicate-warning check.

func strOr(v any) string {
	s, _ := v.(string)
	return s
}

func strOrDefault(v any, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

func strOrNilAny(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func itoa(i int) string { return strconv.Itoa(i) }

// formatFloat renders a Shopify price key the way JS template-string
// interpolation would (`${v.price}` — integer cents, so no decimals).
func formatFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func mustCompileGrams() *regexp.Regexp {
	return regexp.MustCompile(`(?i)(\d+(?:[.,]\d+)?)\s*(kg|g)\b`)
}

// parseFloatComma ports `parseFloat(m[1].replace(',', '.'))` with the
// Number.isFinite guard.
func parseFloatComma(s string) *float64 {
	f, err := strconv.ParseFloat(strings.Replace(s, ",", ".", 1), 64)
	if err != nil {
		return nil
	}
	return &f
}
