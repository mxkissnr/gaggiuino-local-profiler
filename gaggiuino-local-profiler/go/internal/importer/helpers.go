package importer

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// This file ports the small shared helpers lib/import-parsers.js and
// lib/import-generic.js both use: roast-type inference, image-URL
// normalization, altitude/price extraction, the Shopify product-JSON URL
// rewrite, and the loose map accessors that stand in for JS's duck typing
// (every parser here works over a decoded product JSON / bean object as a
// map[string]any, exactly as the Node original works over plain objects).

func today() string { return time.Now().UTC().Format("2006-01-02") }

// jsWhitespace is exactly the character set JavaScript's RegExp `\s` (and
// String.prototype.trim) matches. Go's own regexp `\s` is ASCII-only, but
// the Node parsers' pervasive `.replace(/\s+/g, ' ')` relies on JS `\s`
// also collapsing NBSP (U+00A0), the Unicode spaces and the BOM — real
// roaster product copy is full of `&nbsp;` (e.g. elbgold's
// "Hier&nbsp;findest Du" footer that extractFlavorKeywords stops at).
const jsWhitespace = "\t\n\v\f\r \u00a0\u1680" +
	"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

var jsWhitespaceRe = regexp.MustCompile(
	`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// collapseWS ports the ubiquitous `.replace(/\s+/g, ' ').trim()` in the
// Node parsers.
func collapseWS(s string) string {
	return jsTrim(jsWhitespaceRe.ReplaceAllString(s, " "))
}

// jsTrim ports String.prototype.trim — strings.TrimSpace's unicode.IsSpace
// set is close but not identical, and the parsers compare trimmed values
// for equality.
func jsTrim(s string) string { return strings.Trim(s, jsWhitespace) }

// strOrNil returns s, or nil when s is empty — the Go equivalent of JS's
// `value || null` for a bean field that must always be present in the
// response (serialized as JSON null when absent).
func strOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── loose accessors ────────────────────────────────────────────────────────

func mstr(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func mnum(m map[string]any, key string) (float64, bool) {
	switch v := m[key].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	}
	return 0, false
}

func marr(m map[string]any, key string) []any {
	a, _ := m[key].([]any)
	return a
}

func mobj(m map[string]any, key string) map[string]any {
	o, _ := m[key].(map[string]any)
	return o
}

func anyToStrings(v any) []string {
	a, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(a))
	for _, x := range a {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ── roast type ─────────────────────────────────────────────────────────────

// roastTypeFromTags ports lib/import-parsers.js's roastTypeFromTags(tags).
func roastTypeFromTags(tags []string) string {
	if tags == nil {
		return ""
	}
	joined := strings.ToLower(strings.Join(tags, " "))
	espresso := strings.Contains(joined, "espresso")
	filter := strings.Contains(joined, "filter")
	switch {
	case espresso && filter:
		return "omni"
	case espresso:
		return "espresso"
	case filter:
		return "filter"
	default:
		return ""
	}
}

var profileOptionRe = regexp.MustCompile(`(?i)profile|roast`)

// roastTypeFromProduct ports lib/import-generic.js's roastTypeFromProduct(product):
// prefer an options entry whose name suggests roast profile, fall back to tags.
func roastTypeFromProduct(product map[string]any) string {
	for _, o := range marr(product, "options") {
		om, ok := o.(map[string]any)
		if !ok {
			continue
		}
		if !profileOptionRe.MatchString(mstr(om, "name")) {
			continue
		}
		values := anyToStrings(om["values"])
		if len(values) > 0 {
			if rt := roastTypeFromTags(values); rt != "" {
				return rt
			}
		}
	}
	return roastTypeFromTags(anyToStrings(product["tags"]))
}

// ── image / price ─────────────────────────────────────────────────────────

var httpSchemeRe = regexp.MustCompile(`(?i)^https?://`)

// normalizeImageURL ports lib/import-parsers.js's normalizeImageUrl(url):
// protocol-relative -> https, absolute http(s) untouched, anything else "".
func normalizeImageURL(v any) string {
	url, ok := v.(string)
	if !ok || jsTrim(url) == "" {
		return ""
	}
	s := jsTrim(url)
	if strings.HasPrefix(s, "//") {
		return "https:" + s
	}
	if httpSchemeRe.MatchString(s) {
		return s
	}
	return ""
}

// priceFromProduct ports lib/import-parsers.js's priceFromProduct(product):
// Shopify reports price in cents; > 0 -> euros rounded to the cent, else nil.
func priceFromProduct(product map[string]any) *float64 {
	cents, ok := mnum(product, "price")
	if !ok || cents <= 0 {
		return nil
	}
	v := math.Round(cents) / 100
	return &v
}

// ── altitude ──────────────────────────────────────────────────────────────

const (
	enDash = `\x{2013}`
	emDash = `\x{2014}`
)

var (
	altRangeRe   = regexp.MustCompile(`(?i)(\d{1,2})[.,](\d{3})\s*(?:bis|` + enDash + `|-)\s*(\d{1,2})[.,](\d{3})\s*m(?:eter)?n?\b`)
	altSingleRe  = regexp.MustCompile(`(?i)(\d{1,2})[.,](\d{3})\s*m(?:eter)?n?\b`)
	altPlainUnit = `m\.?a\.?s\.?l\.?|asl|m(?:eter)?s?`

	altPlainRangeRe  = regexp.MustCompile(`(?i)\b(\d{3,4})\s*(?:-|` + enDash + `|` + emDash + `)\s*(\d{3,4})\s*(?:` + altPlainUnit + `)\b`)
	altPlainSingleRe = regexp.MustCompile(`(?i)\b(\d{3,4})\s*(?:` + altPlainUnit + `)\b`)
)

// extractAltitudeM ports lib/import-parsers.js's extractAltitudeM(text).
// Returns nil (JS null) when nothing parses.
func extractAltitudeM(text string) *int {
	if m := altRangeRe.FindStringSubmatch(text); m != nil {
		lo := atoiZ(m[1] + m[2])
		hi := atoiZ(m[3] + m[4])
		v := int(math.Round(float64(lo+hi) / 2))
		return &v
	}
	if m := altSingleRe.FindStringSubmatch(text); m != nil {
		v := atoiZ(m[1] + m[2])
		return &v
	}
	if m := altPlainRangeRe.FindStringSubmatch(text); m != nil {
		v := int(math.Round(float64(atoiZ(m[1])+atoiZ(m[2])) / 2))
		return &v
	}
	if m := altPlainSingleRe.FindStringSubmatch(text); m != nil {
		v := atoiZ(m[1])
		return &v
	}
	return nil
}

func atoiZ(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// ── Shopify product JSON URL ──────────────────────────────────────────────

var shopifyHandleRe = regexp.MustCompile(`(?i)/products/([a-z0-9-]+)`)

// shopifyJSONURL ports lib/import-parsers.js's shopifyJsonUrl(parsedUrl, host):
// rewrites a pasted product URL's path to <host>/products/<handle>.js.
func shopifyJSONURL(pathname, host string) string {
	m := shopifyHandleRe.FindStringSubmatch(pathname)
	if m == nil {
		return ""
	}
	return "https://" + host + "/products/" + m[1] + ".js"
}

// ── roaster-name heuristic ────────────────────────────────────────────────

var lowerWordRe = regexp.MustCompile(`^[a-z]+$`)

// looksLikeRoasterName ports lib/import-generic.js's looksLikeRoasterName(vendor, host).
func looksLikeRoasterName(vendor, host string) bool {
	v := jsTrim(vendor)
	if v == "" {
		return false
	}
	if strings.Contains(v, "_") {
		return false
	}
	if lowerWordRe.MatchString(v) {
		return host != "" && strings.Contains(strings.ToLower(host), strings.ToLower(v))
	}
	return true
}
