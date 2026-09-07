package importer

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"golang.org/x/net/html"
)

// This file ports lib/import-generic.js: the generic Shopify product-JSON
// parser, the JSON-LD and OpenGraph fallbacks, findDuplicateBean, and the
// HTML-only bean-detail enrichment pass (accordion / origin-wrapper / brew-
// guide scrapers). cheerio -> goquery + golang.org/x/net/html.

// ── generic Shopify product JSON ─────────────────────────────────────────

func parseGenericShopifyProduct(product map[string]any, host string) map[string]any {
	title := strings.TrimSpace(mstr(product, "title"))
	if title == "" {
		return nil
	}
	doc := loadHTML(mstr(product, "description"))
	text := collapseWS(doc.Text())
	originCodes := findCountriesInText(title+" "+text, 0)
	vendor := strings.TrimSpace(mstr(product, "vendor"))

	roaster := any(nil)
	if looksLikeRoasterName(vendor, host) {
		roaster = vendor
	} else if host != "" {
		roaster = host
	}

	return map[string]any{
		"name":       title,
		"roaster":    roaster,
		"notes":      "",
		"flavors":    matchFlavorTerms(text, 0),
		"origin":     firstCodeOrNil(originCodes),
		"origins":    codesToOrigins(originCodes),
		"roastType":  strOrNil(roastTypeFromProduct(product)),
		"imageUrl":   normalizeImageURL(product["featured_image"]),
		"price_eur":  floatPtrToAny(priceFromProduct(product)),
		"importedAt": today(),
	}
}

// ── JSON-LD ─────────────────────────────────────────────────────────────

func firstProductNode(v any) map[string]any {
	var roots []any
	switch t := v.(type) {
	case []any:
		roots = t
	case map[string]any:
		if g, ok := t["@graph"].([]any); ok {
			roots = g
		} else {
			roots = []any{t}
		}
	default:
		return nil
	}
	for _, r := range roots {
		node, ok := r.(map[string]any)
		if !ok {
			continue
		}
		switch tp := node["@type"].(type) {
		case string:
			if tp == "Product" {
				return node
			}
		case []any:
			for _, x := range tp {
				if s, _ := x.(string); s == "Product" {
					return node
				}
			}
		}
	}
	return nil
}

func parseJSONLd(htmlStr string) map[string]any {
	doc := loadHTML(htmlStr)
	var product map[string]any
	doc.Find(`script[type="application/ld+json"]`).EachWithBreak(func(_ int, el *goquery.Selection) bool {
		var parsed any
		if err := json.Unmarshal([]byte(el.Text()), &parsed); err != nil {
			return true
		}
		product = firstProductNode(parsed)
		return product == nil
	})
	if product == nil {
		return nil
	}
	name := strings.TrimSpace(mstr(product, "name"))
	if name == "" {
		return nil
	}
	description := strings.TrimSpace(mstr(product, "description"))
	var image any = product["image"]
	if arr, ok := image.([]any); ok && len(arr) > 0 {
		image = arr[0]
	}
	var offers any = product["offers"]
	if arr, ok := offers.([]any); ok && len(arr) > 0 {
		offers = arr[0]
	}
	var price any
	if om, ok := offers.(map[string]any); ok && om["price"] != nil {
		if p, ok := jsParseFloat(om["price"]); ok {
			price = p
		}
	}
	var brand any
	if bm, ok := product["brand"].(map[string]any); ok {
		brand = bm["name"]
	} else {
		brand = product["brand"]
	}
	roaster := any(nil)
	if s, ok := brand.(string); ok {
		roaster = s
	}
	text := name + " " + description
	originCodes := findCountriesInText(text, 0)
	return map[string]any{
		"name":       name,
		"roaster":    roaster,
		"notes":      sliceRunes(description, 500),
		"flavors":    matchFlavorTerms(text, 0),
		"origin":     firstCodeOrNil(originCodes),
		"origins":    codesToOrigins(originCodes),
		"imageUrl":   normalizeImageURL(image),
		"price_eur":  price,
		"importedAt": today(),
	}
}

// ── OpenGraph ───────────────────────────────────────────────────────────

const (
	thinTextChars    = 80
	bodyScanMaxChars = 5000
)

func metaContent(doc *goquery.Document, property string) string {
	c, _ := doc.Find(`meta[property="` + property + `"]`).Attr("content")
	return strings.TrimSpace(c)
}

func metaContentRaw(doc *goquery.Document, property string) (string, bool) {
	return doc.Find(`meta[property="` + property + `"]`).Attr("content")
}

func bodyScanText(doc *goquery.Document) string {
	scope := doc.Find("main, article").First()
	if scope.Length() == 0 || len([]rune(strings.TrimSpace(scope.Text()))) < thinTextChars {
		scope = doc.Find("body")
	}
	return sliceRunes(collapseWS(scope.Text()), bodyScanMaxChars)
}

// mergeUnique ports lib/import-generic.js's mergeUnique(primary, fallback, max).
func mergeUnique(primary, fallback []string, max int) []string {
	seen := map[string]bool{}
	merged := append([]string{}, primary...)
	for _, v := range primary {
		seen[strings.ToLower(v)] = true
	}
	for _, v := range fallback {
		k := strings.ToLower(v)
		if seen[k] {
			continue
		}
		seen[k] = true
		merged = append(merged, v)
	}
	if max > 0 && len(merged) > max {
		merged = merged[:max]
	}
	return merged
}

func parseOpenGraph(htmlStr string) map[string]any {
	doc := loadHTML(htmlStr)
	title := metaContent(doc, "og:title")
	if title == "" {
		return nil
	}
	description := metaContent(doc, "og:description")
	image, _ := metaContentRaw(doc, "og:image")
	siteName := metaContent(doc, "og:site_name")
	priceRaw, ok := metaContentRaw(doc, "og:price:amount")
	if !ok {
		priceRaw, ok = metaContentRaw(doc, "product:price:amount")
	}
	var priceEUR any
	if ok {
		if p, pok := jsParseFloat(priceRaw); pok {
			priceEUR = p
		}
	}

	text := title + " " + description
	originCodes := findCountriesInText(text, 0)
	flavors := matchFlavorTerms(text, 0)

	if len([]rune(strings.TrimSpace(text))) < thinTextChars || (len(originCodes) == 0 && len(flavors) == 0) {
		if bodyText := bodyScanText(doc); bodyText != "" {
			combined := title + " " + bodyText
			originCodes = mergeUnique(originCodes, findCountriesInText(combined, 0), 0)
			flavors = mergeUnique(flavors, matchFlavorTerms(combined, 0), 8)
		}
	}

	return map[string]any{
		"name":       title,
		"roaster":    strOrNil(siteName),
		"notes":      sliceRunes(description, 500),
		"flavors":    flavors,
		"origin":     firstCodeOrNil(originCodes),
		"origins":    codesToOrigins(originCodes),
		"imageUrl":   normalizeImageURL(image),
		"price_eur":  priceEUR,
		"importedAt": today(),
	}
}

// ── HTML-only bean-detail enrichment ────────────────────────────────────

var lineBreakTags = map[string]bool{
	"br": true, "p": true, "div": true, "li": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "tr": true,
}

// textWithLineBreaks ports lib/import-generic.js's textWithLineBreaks: read
// .text() but with a literal "\n" inserted after every block-level element,
// so minified themes with no incidental whitespace between tags don't run
// adjacent lines together.
func textWithLineBreaks(sel *goquery.Selection) string {
	var b strings.Builder
	for _, n := range sel.Nodes {
		nodeTextLB(n, &b)
	}
	return b.String()
}

func nodeTextLB(n *html.Node, b *strings.Builder) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(n.Data)
	case html.ElementNode:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			nodeTextLB(c, b)
		}
		if lineBreakTags[n.Data] {
			b.WriteString("\n")
		}
	default:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			nodeTextLB(c, b)
		}
	}
}

var tabRunRe = regexp.MustCompile(`[ \t]+`)

// accordionLines ports lib/import-generic.js's accordionLines: deduped
// non-empty lines of a content block (insertion order preserved).
func accordionLines(content *goquery.Selection) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range strings.Split(textWithLineBreaks(content), "\n") {
		t := strings.TrimSpace(tabRunRe.ReplaceAllString(raw, " "))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// accordionLabelFields ports ACCORDION_LABEL_FIELDS.
var accordionLabelFields = map[string]string{
	"process": "process", "prozess": "process",
	"variety": "variety", "varietal": "variety", "cultivar": "variety", "sorte": "variety",
	"producer": "producer", "erzeuger": "producer", "produzent": "producer",
	"origin": "region", "region": "region", "terroir": "region", "herkunft": "region", "ursprung": "region",
	"country": "region", "land": "region",
	"elevation": "altitude_m", "altitude": "altitude_m", "höhe": "altitude_m", "hoehe": "altitude_m", "lage": "altitude_m",
}

var accordionLabelRe = func() *regexp.Regexp {
	keys := make([]string, 0, len(accordionLabelFields))
	for k := range accordionLabelFields {
		keys = append(keys, regexp.QuoteMeta(k))
	}
	return regexp.MustCompile(`(?i)^(` + strings.Join(keys, "|") + `)\s*[-–—:]\s*(.+)$`)
}()

// scanAccordionLabelValues ports lib/import-generic.js's scanAccordionLabelValues.
func scanAccordionLabelValues(doc *goquery.Document) map[string]any {
	fields := map[string]any{}
	doc.Find("details").Each(func(_ int, el *goquery.Selection) {
		content := el.Find(".details-content").First()
		if content.Length() == 0 {
			return
		}
		for _, line := range accordionLines(content) {
			m := accordionLabelRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			field := accordionLabelFields[strings.ToLower(m[1])]
			value := strings.TrimSpace(m[2])
			if field == "" || value == "" {
				continue
			}
			if _, exists := fields[field]; exists {
				continue
			}
			if field == "altitude_m" {
				fields[field] = intPtrToAny(extractAltitudeM(value))
			} else {
				fields[field] = value
			}
		}
	})
	return fields
}

// scanOriginWrapperFields ports lib/import-generic.js's scanOriginWrapperFields.
func scanOriginWrapperFields(doc *goquery.Document) map[string]any {
	var blockScopes []*goquery.Selection
	blocks := doc.Find(".origin-content")
	if blocks.Length() > 0 {
		blocks.Each(func(_ int, s *goquery.Selection) { blockScopes = append(blockScopes, s) })
	} else {
		blockScopes = append(blockScopes, doc.Selection)
	}

	var perBlockFields []map[string]any
	for _, scope := range blockScopes {
		fields := map[string]any{}
		scope.Find(".origin-title").Each(func(_ int, el *goquery.Selection) {
			label := strings.ToLower(collapseWS(el.Text()))
			field := accordionLabelFields[label]
			if field == "" {
				return
			}
			if _, exists := fields[field]; exists {
				return
			}
			value := collapseWS(el.NextFiltered("p").Text())
			if value == "" {
				return
			}
			if field == "altitude_m" {
				fields[field] = intPtrToAny(extractAltitudeM(value))
			} else {
				fields[field] = value
			}
		})
		if len(fields) > 0 {
			perBlockFields = append(perBlockFields, fields)
		}
	}

	merged := map[string]any{}
	distinctFields := map[string]bool{}
	for _, f := range accordionLabelFields {
		distinctFields[f] = true
	}
	for field := range distinctFields {
		var values []string
		haveAlt := false
		var altVal any
		for _, f := range perBlockFields {
			v, ok := f[field]
			if !ok || v == nil {
				continue
			}
			if field == "altitude_m" {
				if !haveAlt {
					haveAlt = true
					altVal = v
				}
				continue
			}
			values = append(values, toStringVal(v))
		}
		if field == "altitude_m" {
			if haveAlt {
				merged[field] = altVal
			}
			continue
		}
		if len(values) == 0 {
			continue
		}
		merged[field] = strings.Join(dedupeStrings(values), " / ")
	}
	return merged
}

// scanBeanDetailFields ports lib/import-generic.js's scanBeanDetailFields:
// the <details> accordion scan wins; origin-wrapper only fills gaps.
func scanBeanDetailFields(doc *goquery.Document) map[string]any {
	fields := scanAccordionLabelValues(doc)
	for field, value := range scanOriginWrapperFields(doc) {
		if _, ok := fields[field]; !ok {
			fields[field] = value
		}
	}
	return fields
}

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

func brewLineValue(lines []string, key string) string {
	re := regexp.MustCompile(`(?i)^` + key + `\s*:\s*(.+)$`)
	for _, line := range lines {
		if m := re.FindStringSubmatch(line); m != nil {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

var (
	recipeDetailsRe = regexp.MustCompile(`(?i)recipe\s*details`)
	bulletPrefixRe  = regexp.MustCompile(`^[•*\s]+`)
	brewTempLineRe  = regexp.MustCompile(`(?i)^brew\s*temperature\s*:`)
	brewTimeLineRe  = regexp.MustCompile(`(?i)^brew\s*time\s*:`)
	brewRatioLineRe = regexp.MustCompile(`(?i)^brew\s*ratio\s*:`)
	celsiusRangeRe  = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*[°º]C\s*[-–]\s*(\d+(?:\.\d+)?)\s*[°º]C`)
	brewGuideRe     = regexp.MustCompile(`(?i)brew\s*guide`)
	sentenceEndRe   = regexp.MustCompile(`[.!?]$`)
)

// extractBulletRecipeDetails ports lib/import-generic.js's extractBulletRecipeDetails.
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

// espressoHeadingRe: a heading is a short non-key line not ending in .!?
func isHeading(line string) bool {
	if brewRecipeKeyRe.MatchString(line) {
		return false
	}
	return len([]rune(line)) <= 40 && !sentenceEndRe.MatchString(line)
}

type brewBlock struct {
	heading string
	lines   []string
}

// extractEspressoBrewGuide ports lib/import-generic.js's extractEspressoBrewGuide.
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

// ── subtitle / additional-info / logo alt ───────────────────────────────

func extractTastingNotesSubtitle(doc *goquery.Document) string {
	h1 := doc.Find("h1").First()
	if h1.Length() == 0 {
		return ""
	}
	block := h1.Closest("div")
	if block.Length() == 0 {
		return ""
	}
	sib := block.Next()
	for sib.Length() > 0 {
		text := collapseWS(sib.Text())
		if text == "" {
			sib = sib.Next()
			continue
		}
		if len([]rune(text)) <= 100 && !strings.ContainsAny(text, ".!?") {
			return text
		}
		return ""
	}
	return ""
}

func extractAdditionalInfoFlavors(doc *goquery.Document) []string {
	text := collapseWS(doc.Find(".additional-info").First().Text())
	if text == "" || !strings.Contains(text, "/") {
		return nil
	}
	var out []string
	for _, s := range strings.Split(text, "/") {
		s = strings.TrimSpace(s)
		if s == "" || len([]rune(s)) > 30 {
			continue
		}
		out = append(out, titleCaseWords(s))
	}
	return out
}

func shopNameFromLogoAlt(doc *goquery.Document) string {
	alt, ok := doc.Find(".header-logo__image, .header-logo img, .site-header__logo img").First().Attr("alt")
	if !ok {
		return ""
	}
	cleaned := strings.TrimSpace(regexp.MustCompile(`(?i)\s*[-–—]\s*Home\s*$`).ReplaceAllString(alt, ""))
	return cleaned
}

// ── enrichGenericBeanFromHtml ───────────────────────────────────────────

func enrichGenericBeanFromHTML(bean map[string]any, htmlStr, host string) map[string]any {
	if bean == nil || strings.TrimSpace(htmlStr) == "" {
		return bean
	}
	doc := loadHTML(htmlStr)
	out := cloneBean(bean)

	if subtitle := extractTastingNotesSubtitle(doc); subtitle != "" {
		out["flavors"] = mergeUnique(beanStrings(bean, "flavors"), splitFlavors(subtitle), 8)
	}
	if extra := extractAdditionalInfoFlavors(doc); len(extra) > 0 {
		base := beanStrings(out, "flavors")
		if base == nil {
			base = beanStrings(bean, "flavors")
		}
		out["flavors"] = mergeUnique(base, extra, 8)
	}

	fields := scanBeanDetailFields(doc)
	if beanEmpty(out, "process") && fields["process"] != nil {
		out["process"] = fields["process"]
	}
	if beanEmpty(out, "variety") && fields["variety"] != nil {
		out["variety"] = fields["variety"]
	}
	if beanEmpty(out, "producer") && fields["producer"] != nil {
		out["producer"] = fields["producer"]
	}
	if beanEmpty(out, "region") && fields["region"] != nil {
		out["region"] = fields["region"]
	}
	if beanEmpty(out, "altitude_m") && fields["altitude_m"] != nil {
		out["altitude_m"] = fields["altitude_m"]
	}

	if regionStr, _ := fields["region"].(string); regionStr != "" {
		if extraCodes := findCountriesInText(regionStr, 0); len(extraCodes) > 0 {
			existing := beanOrigins(out)
			have := map[string]bool{}
			for _, o := range existing {
				if c, _ := o["code"].(string); c != "" {
					have[c] = true
				}
			}
			for _, code := range extraCodes {
				if have[code] {
					continue
				}
				have[code] = true
				existing = append(existing, map[string]any{"code": code})
			}
			out["origins"] = existing
			if beanEmpty(out, "origin") {
				if len(existing) > 0 {
					out["origin"] = existing[0]["code"]
				} else {
					out["origin"] = nil
				}
			}
		}
	}

	// Roaster fallback (#433).
	roasterStr, _ := out["roaster"].(string)
	if out["roaster"] == nil || roasterStr == "" || (host != "" && strings.EqualFold(roasterStr, host)) {
		siteName := metaContent(doc, "og:site_name")
		if siteName == "" {
			siteName = shopNameFromLogoAlt(doc)
		}
		if siteName != "" && looksLikeRoasterName(siteName, host) {
			out["roaster"] = siteName
		}
	}

	if brewGuide := extractEspressoBrewGuide(doc); brewGuide != nil {
		if beanEmpty(out, "notes") {
			out["notes"] = strings.TrimSpace("Roaster brew guide (espresso): " + toStringVal(brewGuide["text"]))
		}
		if beanEmpty(out, "brewTempC") && brewGuide["brewTempC"] != nil {
			out["brewTempC"] = brewGuide["brewTempC"]
		}
		if beanEmpty(out, "brewTimeS") && brewGuide["brewTimeS"] != nil {
			out["brewTimeS"] = brewGuide["brewTimeS"]
		}
		if beanEmpty(out, "brewRatio") && brewGuide["brewRatio"] != nil {
			out["brewRatio"] = brewGuide["brewRatio"]
		}
		if beanEmpty(out, "brewNotes") && brewGuide["brewNotes"] != nil {
			out["brewNotes"] = brewGuide["brewNotes"]
		}
		if extra, _ := brewGuide["extraRecipes"].([]map[string]any); len(extra) > 0 {
			out["extraBrewRecipes"] = extra
		}
	}

	if beanEmpty(out, "brewTempC") || beanEmpty(out, "brewTimeS") || beanEmpty(out, "brewRatio") {
		if bullet := extractBulletRecipeDetails(doc); bullet != nil {
			if beanEmpty(out, "brewTempC") && bullet["brewTempC"] != nil {
				out["brewTempC"] = bullet["brewTempC"]
			}
			if beanEmpty(out, "brewTimeS") && bullet["brewTimeS"] != nil {
				out["brewTimeS"] = bullet["brewTimeS"]
			}
			if beanEmpty(out, "brewRatio") && bullet["brewRatio"] != nil {
				out["brewRatio"] = bullet["brewRatio"]
			}
		}
	}

	return out
}

// ── findDuplicateBean ──────────────────────────────────────────────────

func findDuplicateBean(name, roaster, sourceURL string, beans []map[string]any) map[string]any {
	url := strings.TrimSpace(sourceURL)
	if url != "" {
		for _, b := range beans {
			if s, _ := b["sourceUrl"].(string); strings.TrimSpace(s) == url {
				return b
			}
		}
	}
	normName := strings.ToLower(strings.TrimSpace(name))
	normRoaster := strings.ToLower(strings.TrimSpace(roaster))
	if normName == "" {
		return nil
	}
	for _, b := range beans {
		bn, _ := b["name"].(string)
		br, _ := b["roaster"].(string)
		if strings.ToLower(strings.TrimSpace(bn)) == normName && strings.ToLower(strings.TrimSpace(br)) == normRoaster {
			return b
		}
	}
	return nil
}

// ── small util ─────────────────────────────────────────────────────────

func jsParseFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case string:
		m := regexp.MustCompile(`^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`).FindString(t)
		if m == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(m), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func sliceRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func roundHalfUp(f float64) float64 {
	if f < 0 {
		return -roundHalfUp(-f)
	}
	return float64(int64(f + 0.5))
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func toStringVal(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case int:
		return strconv.Itoa(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case nil:
		return ""
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func ternAny(cond bool, ifTrue func() any, ifFalse any) any {
	if cond {
		return ifTrue()
	}
	return ifFalse
}

func titleCaseWords(s string) string {
	return regexp.MustCompile(`\w\S*`).ReplaceAllStringFunc(s, func(w string) string {
		r := []rune(w)
		return strings.ToUpper(string(r[0])) + strings.ToLower(string(r[1:]))
	})
}

// ── bean map helpers ───────────────────────────────────────────────────

func cloneBean(b map[string]any) map[string]any {
	out := make(map[string]any, len(b)+4)
	for k, v := range b {
		out[k] = v
	}
	return out
}

func beanEmpty(b map[string]any, key string) bool {
	v, ok := b[key]
	if !ok || v == nil {
		return true
	}
	switch t := v.(type) {
	case string:
		return t == ""
	}
	return false
}

func beanStrings(b map[string]any, key string) []string {
	switch t := b[key].(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func beanOrigins(b map[string]any) []map[string]any {
	switch t := b["origins"].(type) {
	case []map[string]any:
		return append([]map[string]any{}, t...)
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, x := range t {
			if m, ok := x.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}
