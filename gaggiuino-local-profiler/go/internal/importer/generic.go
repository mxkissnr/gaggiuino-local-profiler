package importer

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/jsnum"
)

// This file holds the generic Shopify product-JSON parser, the JSON-LD and
// OpenGraph fallbacks, findDuplicateBean, and the HTML-only bean-detail
// enrichment pass (accordion / origin-wrapper / brew-guide scrapers), built
// on goquery + golang.org/x/net/html. The accordion / origin-wrapper
// scrapers live in generic_beandetail.go, the brew-guide scrapers in
// generic_brewguide.go.

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

// mergeUnique appends fallback entries to primary, skipping case-insensitive
// duplicates, capped at max.
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
	cleaned := strings.TrimSpace(logoHomeSuffixRe.ReplaceAllString(alt, ""))
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

// jsParseFloat mirrors JS's parseFloat(v); see jsnum.ParseFloat.
var jsParseFloat = jsnum.ParseFloat

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
	return wordRe.ReplaceAllStringFunc(s, func(w string) string {
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
