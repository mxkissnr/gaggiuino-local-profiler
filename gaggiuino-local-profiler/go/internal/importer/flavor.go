package importer

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// This file ports lib/flavor-terms.js's curated vocabulary plus the
// splitFlavors / matchFlavorTerms / extractFlavorKeywords helpers that
// lib/import-parsers.js and lib/import-generic.js share.

// flavorTermsDE mirrors lib/flavor-terms.js's FLAVOR_TERMS_DE exactly,
// order included.
var flavorTermsDE = []string{
	// Fruity
	"Kirsche", "Mandarine", "Orange", "Zitrone", "Zitrus", "Apfel", "Aprikose",
	"Pfirsich", "Traube", "Feige", "Rosine", "Beere", "Himbeere", "Erdbeere",
	"Johannisbeere", "Ananas", "Mango", "Passionsfrucht", "Grapefruit",
	"Litschi", "Lychee", "Guave", "Guava", "Maracuja", "Passion Fruit", "Papaya",
	// Floral
	"Jasmin", "Rose", "Blüte", "Lavendel", "Bergamotte",
	// Sweet / dessert
	"Karamell", "Honig", "Vanille", "Schokolade", "Kakao", "Kakaonibs",
	"Nougat", "Toffee", "Karamellisiert", "brauner Zucker", "Sirup", "Melasse",
	// Nutty
	"Nuss", "Mandel", "Haselnuss", "Walnuss", "Pekannuss",
	// Spice / roasted
	"Zimt", "Nelke", "Pfeffer", "Malz", "Karamellnote",
	// Specialty/process (English shop copy, #400)
	"Tropisch", "Tropical", "Lactic",
}

// flavorTermMatchers precompiles matchFlavorTerms's per-term
// `new RegExp('\\b' + escapeRegex(term) + '\\w*', 'i')`. Go's regexp \b/\w
// are ASCII by default, matching JS's own non-unicode-flag RegExp semantics.
var flavorTermMatchers = func() []*regexp.Regexp {
	out := make([]*regexp.Regexp, len(flavorTermsDE))
	for i, term := range flavorTermsDE {
		out[i] = regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(term) + `\w*`)
	}
	return out
}()

var (
	trailingParenRe = regexp.MustCompile(`\s*\([^)]*\)\s*$`)
	flavorSplitRe   = regexp.MustCompile(`[;,]`)
)

// splitFlavors ports lib/import-parsers.js's splitFlavors(text): split on
// , and ;, strip a trailing parenthesized qualifier, trim, drop empties and
// >50-char fragments, dedupe case-insensitively (first spelling wins).
func splitFlavors(text string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range flavorSplitRe.Split(text, -1) {
		s := strings.TrimSpace(trailingParenRe.ReplaceAllString(raw, ""))
		if s == "" || utf8.RuneCountInString(s) > 50 {
			continue
		}
		key := strings.ToLower(s)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, s)
	}
	return out
}

// matchFlavorTerms ports lib/import-generic.js's matchFlavorTerms(text, max=8):
// scan prose for the curated vocabulary, then run the hits through
// splitFlavors and cap at max.
func matchFlavorTerms(text string, max int) []string {
	if max == 0 {
		max = 8
	}
	if text == "" {
		return []string{}
	}
	found := []string{}
	for i, re := range flavorTermMatchers {
		if re.MatchString(text) {
			found = append(found, flavorTermsDE[i])
		}
	}
	res := splitFlavors(strings.Join(found, ", "))
	if len(res) > max {
		res = res[:max]
	}
	return res
}

var flavorHeadingRe = regexp.MustCompile(`(?i)(?:Sensorik|Geschmack|Aromen?)\s*[–—:-]?\s*[^.]{0,60}`)

// extractFlavorKeywords ports lib/import-parsers.js's extractFlavorKeywords(text):
// narrow to the window after a Sensorik/Geschmack/Aromen heading (stopping
// at "Hier findest Du" or 600 chars), then run matchFlavorTerms over it.
func extractFlavorKeywords(text string) []string {
	loc := flavorHeadingRe.FindStringIndex(text)
	if loc == nil {
		return []string{}
	}
	start := loc[1]
	rest := text[start:]
	stopIdx := strings.Index(rest, "Hier findest Du")
	var window string
	if stopIdx > -1 {
		window = rest[:stopIdx]
	} else if len(rest) > 600 {
		window = rest[:600]
	} else {
		window = rest
	}
	return matchFlavorTerms(window, 0)
}
