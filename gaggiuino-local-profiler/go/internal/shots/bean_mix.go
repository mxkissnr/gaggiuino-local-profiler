package shots

import (
	"math"
	"strings"
)

// Bean mix (#1837): several beans in one shot. A mixed shot's annotation
// carries `beanMix`, a 2-4 entry array of per-bean shares, next to the usual
// top-level coffee/beanId naming its primary bean (the part with the most
// grams). Every other field keeps today's meaning, so code that is not
// mix-aware still reads the primary bean exactly as before, and stock uses the
// parts alone (never the top-level dose, which would count it twice).

// BeanMixPart is one bean's share of a mixed shot's dose: the library bean
// when the part names one, its display name and the grams it contributed.
type BeanMixPart struct {
	BeanID *int64
	Coffee string
	Grams  float64
}

const (
	minBeanMixParts = 2
	maxBeanMixParts = 4
)

// BeanMix returns the annotation's bean-mix parts, or nil when it carries no
// usable mix: absent, not an array, or fewer than two well-formed parts (a
// single-bean shot never has one).
func BeanMix(ann map[string]any) []BeanMixPart {
	return beanMixParts(ann["beanMix"])
}

// IsBeanMix reports whether the annotation describes a mixed shot.
func IsBeanMix(ann map[string]any) bool {
	return len(BeanMix(ann)) >= minBeanMixParts
}

// BeanLabel returns the annotation's bean label: "A + B" for a mixed shot, the
// single coffee name otherwise.
func BeanLabel(ann map[string]any) string {
	parts := BeanMix(ann)
	if len(parts) == 0 {
		s, _ := ann["coffee"].(string)
		return s
	}
	names := make([]string, len(parts))
	for i, part := range parts {
		names[i] = part.Coffee
	}
	return strings.Join(names, " + ")
}

// beanMixParts decodes a raw `beanMix` value — a JSON-decoded []any of
// map[string]any, or that same shape built by hand — and keeps the well-formed
// parts: a non-empty coffee name and a positive grams number. A malformed entry
// is skipped rather than failing the whole mix, so a partly bad annotation
// still books the stock its valid parts describe (validation reports the bad
// entry separately).
func beanMixParts(raw any) []BeanMixPart {
	list, ok := raw.([]any)
	if !ok || len(list) < minBeanMixParts {
		return nil
	}
	parts := make([]BeanMixPart, 0, len(list))
	for _, entry := range list {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		coffee, _ := m["coffee"].(string)
		grams, ok := m["grams"].(float64)
		if coffee == "" || !ok || !(grams > 0) {
			continue
		}
		part := BeanMixPart{Coffee: coffee, Grams: grams}
		if f, ok := m["beanId"].(float64); ok {
			if id, ok := jsonInt64(f); ok {
				part.BeanID = &id
			}
		}
		parts = append(parts, part)
	}
	if len(parts) < minBeanMixParts {
		return nil
	}
	return parts
}

// jsonInt64 converts an integral JSON number to int64, reporting false when the
// value is outside int64's range (the caller has already established that f has
// no fractional part).
func jsonInt64(f float64) (int64, bool) {
	if f < float64(math.MinInt64) || f >= float64(math.MaxInt64) {
		return 0, false
	}
	return int64(f), true
}
