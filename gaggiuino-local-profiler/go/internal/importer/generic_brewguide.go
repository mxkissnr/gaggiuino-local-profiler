package importer

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// ── brew guide ──────────────────────────────────────────────────────────

var brewRecipeKeyRe = regexp.MustCompile(`(?i)^(In|Out|Time|Ratio|Temp)\s*:`)
var numRe = regexp.MustCompile(`\d+(?:\.\d+)?`)

func rangeMidpoint(raw string) (float64, bool) {
	if raw == "" {
		return 0, false
	}
	nums := numRe.FindAllString(raw, -1)
	if len(nums) == 0 {
		return 0, false
	}
	if len(nums) > 1 {
		a, _ := strconv.ParseFloat(nums[0], 64)
		b, _ := strconv.ParseFloat(nums[1], 64)
		return (a + b) / 2, true
	}
	a, _ := strconv.ParseFloat(nums[0], 64)
	return a, true
}

func ratioLabel(raw string) any {
	if raw == "" {
		return nil
	}
	nums := numRe.FindAllString(raw, -1)
	if len(nums) >= 2 {
		return nums[0] + ":" + nums[1]
	}
	return nil
}

func firstNumber(raw string) any {
	if raw == "" {
		return nil
	}
	m := numRe.FindString(raw)
	if m == "" {
		return nil
	}
	f, _ := strconv.ParseFloat(m, 64)
	return f
}

// brewLineRe builds brewLineValue's per-key matcher; key is a fixed
// identifier from this file, inserted as-is.
func brewLineRe(key string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)^` + key + `\s*:\s*(.+)$`)
}

// brewLineRes holds brewLineRe for every key the brew-guide parser asks
// for, compiled once instead of on every call (#1616).
var brewLineRes = func() map[string]*regexp.Regexp {
	out := map[string]*regexp.Regexp{}
	for _, key := range []string{"In", "Out", "Time", "Ratio", "Temp"} {
		out[key] = brewLineRe(key)
	}
	return out
}()

func brewLineValue(lines []string, key string) string {
	re, ok := brewLineRes[key]
	if !ok {
		re = brewLineRe(key)
	}
	for _, line := range lines {
		if m := re.FindStringSubmatch(line); m != nil {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

var (
	recipeDetailsRe  = regexp.MustCompile(`(?i)recipe\s*details`)
	bulletPrefixRe   = regexp.MustCompile(`^[•*\s]+`)
	brewTempLineRe   = regexp.MustCompile(`(?i)^brew\s*temperature\s*:`)
	brewTimeLineRe   = regexp.MustCompile(`(?i)^brew\s*time\s*:`)
	brewRatioLineRe  = regexp.MustCompile(`(?i)^brew\s*ratio\s*:`)
	celsiusRangeRe   = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*[°º]C\s*[-–]\s*(\d+(?:\.\d+)?)\s*[°º]C`)
	brewGuideRe      = regexp.MustCompile(`(?i)brew\s*guide`)
	sentenceEndRe    = regexp.MustCompile(`[.!?]$`)
	wordRe           = regexp.MustCompile(`[\p{L}\p{N}_]\S*`)
	logoHomeSuffixRe = regexp.MustCompile(`(?i)\s*[-–—]\s*Home\s*$`)
)

func extractBulletRecipeDetails(doc *goquery.Document) map[string]any {
	var content *goquery.Selection
	doc.Find(".recipe-title").EachWithBreak(func(_ int, el *goquery.Selection) bool {
		if !recipeDetailsRe.MatchString(strings.TrimSpace(el.Text())) {
			return true
		}
		next := el.NextFiltered("p")
		if next.Length() > 0 {
			content = next
		} else {
			content = el.Parent()
		}
		return false
	})
	if content == nil || content.Length() == 0 {
		return nil
	}
	var lines []string
	for _, l := range strings.Split(textWithLineBreaks(content), "\n") {
		l = strings.TrimSpace(tabRunRe.ReplaceAllString(bulletPrefixRe.ReplaceAllString(l, ""), " "))
		if l != "" {
			lines = append(lines, l)
		}
	}
	tempLine := findLine(lines, brewTempLineRe)
	timeLine := findLine(lines, brewTimeLineRe)
	ratioLine := findLine(lines, brewRatioLineRe)
	if tempLine == "" && timeLine == "" && ratioLine == "" {
		return nil
	}
	var brewTempC any
	if tempLine != "" {
		if m := celsiusRangeRe.FindStringSubmatch(tempLine); m != nil {
			a, _ := strconv.ParseFloat(m[1], 64)
			b, _ := strconv.ParseFloat(m[2], 64)
			brewTempC = (a + b) / 2
		}
	}
	var brewTimeS any
	if timeLine != "" {
		if mid, ok := rangeMidpoint(timeLine); ok {
			brewTimeS = int(roundHalfUp(mid))
		}
	}
	return map[string]any{
		"brewTempC": brewTempC,
		"brewTimeS": brewTimeS,
		"brewRatio": ternAny(ratioLine != "", func() any { return ratioLabel(ratioLine) }, nil),
	}
}

func findLine(lines []string, re *regexp.Regexp) string {
	for _, l := range lines {
		if re.MatchString(l) {
			return l
		}
	}
	return ""
}

type brewBlock struct {
	heading string
	lines   []string
}

func extractEspressoBrewGuide(doc *goquery.Document) map[string]any {
	var content *goquery.Selection
	doc.Find("details").EachWithBreak(func(_ int, el *goquery.Selection) bool {
		summary := el.Find("summary").First().Clone()
		summary.Find("span").Remove()
		if brewGuideRe.MatchString(strings.TrimSpace(summary.Text())) {
			content = el.Find(".details-content").First()
			return false
		}
		return true
	})
	if content == nil || content.Length() == 0 {
		return nil
	}

	var lines []string
	for _, l := range strings.Split(textWithLineBreaks(content), "\n") {
		lines = append(lines, strings.TrimSpace(tabRunRe.ReplaceAllString(l, " ")))
	}

	var blocks []brewBlock
	var current *brewBlock
	prepNote := ""
	for _, line := range lines {
		if line == "" {
			continue
		}
		isKeyLine := brewRecipeKeyRe.MatchString(line)
		heading := !isKeyLine && len([]rune(line)) <= 40 && !sentenceEndRe.MatchString(line)
		if heading {
			if current != nil {
				blocks = append(blocks, *current)
			}
			current = &brewBlock{heading: line}
			continue
		}
		if current != nil {
			current.lines = append(current.lines, line)
		}
		if prepNote == "" && !isKeyLine && len([]rune(line)) > 40 {
			prepNote = line
		}
	}
	if current != nil {
		blocks = append(blocks, *current)
	}

	type candidate struct {
		brewBlock
		keyCount int
	}
	var candidates []candidate
	for _, b := range blocks {
		keys := map[string]bool{}
		for _, l := range b.lines {
			if m := brewRecipeKeyRe.FindStringSubmatch(l); m != nil {
				keys[strings.ToLower(m[1])] = true
			}
		}
		if len(keys) >= 3 {
			candidates = append(candidates, candidate{b, len(keys)})
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	chosenIdx := 0
	for i, c := range candidates {
		if strings.EqualFold(c.heading, "espresso") {
			chosenIdx = i
			break
		}
	}
	chosen := candidates[chosenIdx]

	timeMid, timeOk := rangeMidpoint(brewLineValue(chosen.lines, "Time"))

	var extraRecipes []map[string]any
	for i, c := range candidates {
		if i == chosenIdx {
			continue
		}
		bTimeMid, bOk := rangeMidpoint(brewLineValue(c.lines, "Time"))
		var targetTime any
		if bOk {
			targetTime = int(roundHalfUp(bTimeMid))
		}
		extraRecipes = append(extraRecipes, map[string]any{
			"name":          c.heading,
			"targetDose_g":  firstNumber(brewLineValue(c.lines, "In")),
			"targetYield_g": firstNumber(brewLineValue(c.lines, "Out")),
			"targetTime_s":  targetTime,
			"waterTemp_c":   midpointOrNil(brewLineValue(c.lines, "Temp")),
			"notes":         strings.TrimSpace(c.heading + "\n" + strings.Join(c.lines, "\n")),
		})
	}

	var brewTimeS any
	if timeOk {
		brewTimeS = int(roundHalfUp(timeMid))
	}
	return map[string]any{
		"text":         strings.TrimSpace(chosen.heading + "\n" + strings.Join(chosen.lines, "\n")),
		"brewTempC":    midpointOrNil(brewLineValue(chosen.lines, "Temp")),
		"brewTimeS":    brewTimeS,
		"brewRatio":    ratioLabel(brewLineValue(chosen.lines, "Ratio")),
		"brewNotes":    strOrNil(prepNote),
		"extraRecipes": extraRecipes,
	}
}

func midpointOrNil(raw string) any {
	if v, ok := rangeMidpoint(raw); ok {
		return v
	}
	return nil
}
