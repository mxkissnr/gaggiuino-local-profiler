package shots

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// This file (#901, design pass 4 follow-up) ports public-src/views/shots/
// grind.js's calcComparativeGrindAdvice: "which grind setting scores best
// among this shot's comparable siblings" — deliberately NOT ported
// alongside internal/shots/detail.go's own ComputeGrindAdvice (single-shot
// dial-in heuristic) because, per that file's own doc comment, this needs
// the full shot history, not just one shot. Now that internal/web's Shots
// page has a natural place to fetch that history (the same machine's
// FindAllExcludingTrashByMachine internal/web already loads for the list
// column), that gap closes here.

// grindNumRe ports grind.js's _parseGrindNum regex: the first
// integer-or-decimal numeric substring in a free-text grind setting string
// ("Setting 3.5" -> 3.5, "3,5" -> 3.5 via the comma-to-dot swap below).
var grindNumRe = regexp.MustCompile(`\d+(?:[.,]\d+)?`)

// parseGrindNum ports grind.js's _parseGrindNum(s).
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

// ComparativeGrindAdvice mirrors calcComparativeGrindAdvice's return shape
// — Type/Icon/Text follow the same convention as GrindAdvice
// (detail.go), plus the sample count and the best-scoring grind
// setting/score the advice text quotes.
type ComparativeGrindAdvice struct {
	// Type is "finer" | "coarser" | "ok".
	Type string
	Icon string
	Text string

	SampleCount      int
	BestGrindSetting float64
	BestScore        int
}

// comparativeSameBean mirrors calcComparativeGrindAdvice's own sameBean
// closure: beanId-first match when both sides have one (a row whose beanId
// points at a different bean is NOT rescued by a name match — same #456
// convention library.ComputeBeanRemaining already follows), else a
// case-insensitive coffee-name comparison.
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

// ComputeComparativeGrindAdvice ports calcComparativeGrindAdvice(shot,
// allShots) — allShots should be every other shot on shot's own machine
// (internal/shots.Repository.FindAllExcludingTrashByMachine), matching
// Node's own S.shots (already machine-filtered upstream by
// filterShotsByMachine before ever reaching this function).
func ComputeComparativeGrindAdvice(shot Shot, allShots []Shot) *ComparativeGrindAdvice {
	ann := toMap(shot["annotation"])
	coffee := strings.ToLower(strings.TrimSpace(annotationStr(ann, "coffee")))
	grinder := strings.ToLower(strings.TrimSpace(annotationStr(ann, "grinder")))
	profile := strings.ToLower(strings.TrimSpace(shot.profileName()))
	if coffee == "" || grinder == "" {
		return nil
	}
	dose, hasDose := toFloat(ann["dose"])
	currentGrind, hasCurrentGrind := parseGrindNum(annotationStr(ann, "grindSetting"))
	shotID := shot.id()

	type comparableShot struct {
		grind float64
		score int
	}
	var comparable []comparableShot
	for _, s := range allShots {
		if s.id() == shotID {
			continue
		}
		a := toMap(s["annotation"])
		if !comparativeSameBean(ann, a) {
			continue
		}
		if strings.ToLower(strings.TrimSpace(annotationStr(a, "grinder"))) != grinder {
			continue
		}
		if strings.ToLower(strings.TrimSpace(s.profileName())) != profile {
			continue
		}
		if hasDose && dose > 0 {
			sd, ok := toFloat(a["dose"])
			if !ok || sd <= 0 || abs(sd-dose) > 1 {
				continue
			}
		}
		g, ok := parseGrindNum(annotationStr(a, "grindSetting"))
		if !ok {
			continue
		}
		score := CalcShotScore(s, nil)
		if score == nil {
			continue
		}
		comparable = append(comparable, comparableShot{grind: g, score: *score})
	}
	if len(comparable) < 1 {
		return nil
	}

	byGrind := map[float64][]int{}
	for _, c := range comparable {
		key := roundToHalf(c.grind)
		byGrind[key] = append(byGrind[key], c.score)
	}

	// #901 code review (CONFIRMED finding #3): Go's map iteration order is
	// randomized per-run, so picking the best bucket via `for key := range
	// byGrind` made the result nondeterministic whenever two grind-setting
	// buckets landed on the exact same average score (realistic — avg is
	// sum(int)/len(int), a common rational) — the same shot's page could
	// recommend a different "best" grind setting on different loads. Sort
	// the keys first and iterate in that fixed order, with a strict `>`
	// comparison so the first (lowest) key seen wins any exact tie — a
	// pragmatic, explicit tiebreak (favor the finer/lower setting) rather
	// than Node's own `Object.entries` order, which for this function's
	// non-integer-string keys ("3.5" etc.) was itself just whatever
	// insertion order happened to produce, not a rule this port could
	// faithfully carry over.
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

	if !hasCurrentGrind {
		return &ComparativeGrindAdvice{
			Type: "ok", Icon: "📊",
			Text:        comparativeOkText(n, bestSetting, bestScore),
			SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
		}
	}
	diff := currentGrind - bestSetting
	if abs(diff) < 0.6 {
		return &ComparativeGrindAdvice{
			Type: "ok", Icon: "📊",
			Text:        comparativeOkText(n, bestSetting, bestScore),
			SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
		}
	}
	if diff > 0 {
		return &ComparativeGrindAdvice{
			Type: "finer", Icon: "📊",
			Text:        fmt.Sprintf("%d comparable shots: grind %g → score %d — grind finer", n, bestSetting, bestScore),
			SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
		}
	}
	return &ComparativeGrindAdvice{
		Type: "coarser", Icon: "📊",
		Text:        fmt.Sprintf("%d comparable shots: grind %g → score %d — grind coarser", n, bestSetting, bestScore),
		SampleCount: n, BestGrindSetting: bestSetting, BestScore: bestScore,
	}
}

func comparativeOkText(n int, bestSetting float64, bestScore int) string {
	return fmt.Sprintf("%d comparable shots confirm your grind setting (avg score %d)", n, bestScore)
}

// annotationStr reads ann[key] as a string, or "" if absent/not a string —
// this package's own equivalent of internal/web's annotationString (kept
// local, not shared, matching that file's own note about
// small-enough-not-to-share helpers).
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

// roundToHalf ports JS's `Math.round(g * 2) / 2` grind-setting bucketing.
func roundToHalf(v float64) float64 {
	return roundHalfAwayFromZero(v*2) / 2
}

// roundHalfAwayFromZero ports JS's Math.round (half-up, not Go's
// round-half-to-even default) — only matters at exact .5 boundaries, but
// grind settings land there often enough (whole and half increments) that
// the distinction is worth getting right.
func roundHalfAwayFromZero(v float64) float64 {
	if v < 0 {
		return -roundHalfAwayFromZero(-v)
	}
	return float64(int64(v + 0.5))
}
