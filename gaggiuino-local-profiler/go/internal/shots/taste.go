package shots

import (
	"slices"
	"strings"
)

// Taste tags (#1957): how a shot tasted, stored as the optional annotation key
// "tasteTag". One tag per shot, because the advice needs one direction. They
// feed the grind advice only and never the shot score.
const (
	tasteSour     = "sour"
	tasteBitter   = "bitter"
	tasteBalanced = "balanced"
	tasteThin     = "thin"
)

var tasteTags = []string{tasteSour, tasteBitter, tasteBalanced, tasteThin}

// TasteTags lists the valid tags.
func TasteTags() []string {
	return slices.Clone(tasteTags)
}

// tasteTagOf returns ann's tag. An absent or unknown value is "": a backup
// from a newer version may carry a tag this one does not know.
func tasteTagOf(ann map[string]any) string {
	tag := annotationStr(ann, "tasteTag")
	if slices.Contains(tasteTags, tag) {
		return tag
	}
	return ""
}

// checkTasteTag validates a tag being written. It is deliberately not part of
// ValidateAnnotation: a restore drops every annotation failing that check, and
// one unknown tag must not cost a whole annotation.
func checkTasteTag(body map[string]any) []ValidationIssue {
	v, present := body["tasteTag"]
	if !present {
		return nil
	}
	if s, ok := v.(string); ok && slices.Contains(tasteTags, s) {
		return nil
	}
	return []ValidationIssue{{"tasteTag", "Must be one of " + strings.Join(tasteTags, ", ")}}
}

// Outcomes of a tag against a grind direction, besides "finer" and "coarser".
const (
	tasteHold     = "hold"
	tasteConflict = "conflict"
)

// tasteOutcome is what tag does to dir ("finer", "coarser" or "" for none):
// "" keeps the advice as it is. Keep in step with _tasteOutcome in
// public-src/views/shots/grind.ts.
func tasteOutcome(tag, dir string) string {
	want := ""
	switch tag {
	case tasteSour:
		want = "finer"
	case tasteBitter:
		want = "coarser"
	case tasteBalanced:
		if dir != "" {
			return tasteHold
		}
		return ""
	default:
		return ""
	}
	if dir == "" {
		return want
	}
	if dir != want {
		return tasteConflict
	}
	return ""
}

// grindDirection is the direction a difference from the best setting asks
// for, "" when within the 0.6 the advice treats as on target.
func grindDirection(diff float64) string {
	switch {
	case abs(diff) < 0.6:
		return ""
	case diff > 0:
		return "finer"
	default:
		return "coarser"
	}
}

// rankableSiblings drops siblings the user tasted as sour or bitter, unless
// that would leave none.
func rankableSiblings(all []comparableSibling) []comparableSibling {
	kept := make([]comparableSibling, 0, len(all))
	for _, c := range all {
		if c.tasteTag != tasteSour && c.tasteTag != tasteBitter {
			kept = append(kept, c)
		}
	}
	if len(kept) == 0 {
		return all
	}
	return kept
}

// tasteAdvice phrases a non-empty tasteOutcome.
func tasteAdvice(outcome, lang string, n int, best float64, score int) *ComparativeGrindAdvice {
	adviceType := outcome
	if outcome == tasteHold || outcome == tasteConflict {
		adviceType = "ok"
	}
	return &ComparativeGrindAdvice{
		Type: adviceType, Icon: "📊",
		Text:        cardTextf(lang, "compare_taste_"+outcome, n, best, score),
		SampleCount: n, BestGrindSetting: best, BestScore: score,
	}
}
