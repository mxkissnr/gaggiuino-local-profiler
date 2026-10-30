package shots

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// This file computes the comparative grind advice: "which grind setting
// scores best among this shot's comparable siblings". It is deliberately
// separate from detail.go's ComputeGrindAdvice (single-shot dial-in
// heuristic) because it compares the shot with the machine's other shots
// (Service.GetComparativeGrindAdvice).

// grindNumRe is the regex for the first integer-or-decimal numeric substring
// in a free-text grind setting string ("Setting 3.5" -> 3.5, "3,5" -> 3.5 via
// the comma-to-dot swap below).
var grindNumRe = regexp.MustCompile(`\d+(?:[.,]\d+)?`)

func parseGrindNum(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	m := grindNumRe.FindString(s)
	if m == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.Replace(m, ",", ".", 1), 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// ComparativeGrindAdvice is the advice plus its evidence: Type/Icon/Text
// follow the same convention as GrindAdvice (detail.go), plus the sample count
// and the best-scoring grind setting/score the advice text quotes.
type ComparativeGrindAdvice struct {
	// Type is "finer" | "coarser" | "ok".
	Type string
	Icon string
	Text string

	SampleCount      int
	BestGrindSetting float64
	BestScore        int
}

// comparativeSameBean reports whether two annotations describe the same bean:
// beanId-first match when both sides have one (a row whose beanId points at a
// different bean is NOT rescued by a name match — the same #456 convention
// library.ComputeBeanRemaining already follows), else a case-insensitive
// coffee-name comparison.
func comparativeSameBean(annA, annB map[string]any) bool {
	beanIDA, hasA := annA["beanId"]
	beanIDB, hasB := annB["beanId"]
	if hasA && hasB && beanIDA != nil && beanIDB != nil {
		fa, okA := toFloat(beanIDA)
		fb, okB := toFloat(beanIDB)
		if okA && okB {
			return fa == fb
		}
	}
	coffeeA, _ := annA["coffee"].(string)
	coffeeB, _ := annB["coffee"].(string)
	return coffeeA != "" && strings.EqualFold(strings.TrimSpace(coffeeA), strings.TrimSpace(coffeeB))
}

// comparativeMatch is one reference shot's comparison key — what decides
// whether another shot of the same machine is comparable (same bean,
// grinder and profile, dose within 1 g, a numeric grind setting).
type comparativeMatch struct {
	shotID          int64
	ann             map[string]any
	grinder         string
	profile         string
	dose            float64
	hasDose         bool
	currentGrind    float64
	hasCurrentGrind bool
}

// comparableSibling is one comparable sibling's grind setting and score.
type comparableSibling struct {
	grind float64
	score int
}

// newComparativeMatch returns shot's comparison key, or nil when shot has
// no coffee or grinder (no advice is possible then), or is a mixed shot
// (#1837): a bean mix has no single bean to compare grind settings against.
func newComparativeMatch(shot Shot) *comparativeMatch {
	ann := toMap(shot["annotation"])
	if IsBeanMix(ann) {
		return nil
	}
	coffee := strings.ToLower(strings.TrimSpace(annotationStr(ann, "coffee")))
	grinder := strings.ToLower(strings.TrimSpace(annotationStr(ann, "grinder")))
	if coffee == "" || grinder == "" {
		return nil
	}
	m := &comparativeMatch{
		shotID:  shot.id(),
		ann:     ann,
		grinder: grinder,
		profile: strings.ToLower(strings.TrimSpace(shot.profileName())),
	}
	m.dose, m.hasDose = toFloat(ann["dose"])
	m.currentGrind, m.hasCurrentGrind = parseGrindNum(annotationStr(ann, "grindSetting"))
	return m
}

// grindOf reports whether s is comparable to the reference shot and, if
// so, s's numeric grind setting. It reads only s's id, profile name and
// annotation.
func (m *comparativeMatch) grindOf(s Shot) (float64, bool) {
	if s.id() == m.shotID {
		return 0, false
	}
	a := toMap(s["annotation"])
	// A mixed shot is neither bean, so it never counts as a sibling (#1837).
	if IsBeanMix(a) || !comparativeSameBean(m.ann, a) {
		return 0, false
	}
	if strings.ToLower(strings.TrimSpace(annotationStr(a, "grinder"))) != m.grinder {
		return 0, false
	}
	if strings.ToLower(strings.TrimSpace(s.profileName())) != m.profile {
		return 0, false
	}
	if m.hasDose && m.dose > 0 {
		sd, ok := toFloat(a["dose"])
		if !ok || sd <= 0 || abs(sd-m.dose) > 1 {
			return 0, false
		}
	}
	return parseGrindNum(annotationStr(a, "grindSetting"))
}

// advice ranks the comparable shots' grind settings and phrases the result
// in lang, relative to the reference shot's own setting; nil when nothing
// compares.
func (m *comparativeMatch) advice(comparable []comparableSibling, lang string) *ComparativeGrindAdvice {
	if len(comparable) < 1 {
		return nil
	}

	byGrind := map[float64][]int{}
	for _, c := range comparable {
		key := roundToHalf(c.grind)
		byGrind[key] = append(byGrind[key], c.score)
	}

	// Go's map iteration order is randomized per-run, so picking the best
	// bucket via `for key := range byGrind` would make the result
	// nondeterministic whenever two grind-setting buckets landed on the exact
	// same average score (realistic — avg is sum(int)/len(int), a common
	// rational) — the same shot's page could recommend a different "best"
	// grind setting on different loads. Sort the keys first and iterate in
	// that fixed order, with a strict `>` comparison so the first (lowest) key
	// seen wins any exact tie — a pragmatic, explicit tiebreak favoring the
	// finer/lower setting.
	keys := make([]float64, 0, len(byGrind))
	for key := range byGrind {
		keys = append(keys, key)
	}
	sort.Float64s(keys)

	bestSetting := 0.0
	bestAvg := -1.0
	haveBest := false
	for _, key := range keys {
		scores := byGrind[key]
		sum := 0
		for _, sc := range scores {
			sum += sc
		}
		avg := float64(sum) / float64(len(scores))
		if avg > bestAvg {
			bestAvg = avg
			bestSetting = key
			haveBest = true
		}
	}
	if !haveBest {
		return nil
	}

	n := len(comparable)
	bestScore := int(roundHalfAwayFromZero(bestAvg))

	if !m.hasCurrentGrind {
		return &ComparativeGrindAdvice{
			Type: "ok", Icon: "📊",
			Text:        cardTextf(lang, "compare_ok", n, bestScore),
			SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
		}
	}
	diff := m.currentGrind - bestSetting
	if abs(diff) < 0.6 {
		return &ComparativeGrindAdvice{
			Type: "ok", Icon: "📊",
			Text:        cardTextf(lang, "compare_ok", n, bestScore),
			SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
		}
	}
	if diff > 0 {
		return &ComparativeGrindAdvice{
			Type: "finer", Icon: "📊",
			Text:        cardTextf(lang, "compare_finer", n, bestSetting, bestScore),
			SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
		}
	}
	return &ComparativeGrindAdvice{
		Type: "coarser", Icon: "📊",
		Text:        cardTextf(lang, "compare_coarser", n, bestSetting, bestScore),
		SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
	}
}

// annotationStr reads ann[key] as a string, or "" if absent/not a string.
func annotationStr(ann map[string]any, key string) string {
	v, _ := ann[key].(string)
	return v
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

// roundToHalf buckets a grind setting to the nearest half: Math.round(g*2)/2.
func roundToHalf(v float64) float64 {
	return roundHalfAwayFromZero(v*2) / 2
}

// roundHalfAwayFromZero rounds half away from zero, like math.Round.
func roundHalfAwayFromZero(v float64) float64 {
	if v < 0 {
		return -roundHalfAwayFromZero(-v)
	}
	return float64(int64(v + 0.5))
}
