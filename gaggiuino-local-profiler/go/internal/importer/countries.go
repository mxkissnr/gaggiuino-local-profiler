package importer

import "strings"

// This file ports lib/coffee-countries.js: mapOriginToCode + findCountriesInText.
//
// The Node original builds its localized-name -> alpha-2 map at module load
// from Intl.DisplayNames (de + en) over COFFEE_COUNTRY_CODES, plus a handful
// of manual aliases. Go's standard library has no ICU/CLDR region-name table,
// so countryNames below is that exact map captured once from Node (the same
// insertion order: the four manual aliases first, then the `de` pass, then
// the `en` pass) and kept as static data. It is a data table, not logic —
// regenerate it from lib/coffee-countries.js if the CLDR names ever drift.
//
// An ordered slice (not a Go map) is deliberate: findCountriesInText sorts
// its hits by first-appearance position with a stable sort, and JS Map
// iteration order is insertion order — a Go map's randomized range would
// change the tie-break for two names that resolve to different codes at the
// same text position.

type countryName struct {
	name string
	code string
}

var countryNames = []countryName{
	{"hawaii", "US"}, {"kongo", "CD"}, {"dr kongo", "CD"}, {"osttimor", "TL"},
	{"angola", "AO"}, {"burundi", "BI"}, {"bolivien", "BO"}, {"brasilien", "BR"},
	{"kongo-kinshasa", "CD"}, {"côte d’ivoire", "CI"}, {"kamerun", "CM"}, {"china", "CN"},
	{"kolumbien", "CO"}, {"costa rica", "CR"}, {"kuba", "CU"}, {"dominikanische republik", "DO"},
	{"ecuador", "EC"}, {"äthiopien", "ET"}, {"ghana", "GH"}, {"guatemala", "GT"},
	{"honduras", "HN"}, {"haiti", "HT"}, {"indonesien", "ID"}, {"indien", "IN"},
	{"jamaika", "JM"}, {"kenia", "KE"}, {"kambodscha", "KH"}, {"laos", "LA"},
	{"sri lanka", "LK"}, {"myanmar", "MM"}, {"malawi", "MW"}, {"mexiko", "MX"},
	{"mosambik", "MZ"}, {"nicaragua", "NI"}, {"nepal", "NP"}, {"panama", "PA"},
	{"peru", "PE"}, {"papua-neuguinea", "PG"}, {"philippinen", "PH"}, {"ruanda", "RW"},
	{"el salvador", "SV"}, {"thailand", "TH"}, {"timor-leste", "TL"}, {"tansania", "TZ"},
	{"uganda", "UG"}, {"vereinigte staaten", "US"}, {"venezuela", "VE"}, {"vietnam", "VN"},
	{"jemen", "YE"}, {"sambia", "ZM"}, {"simbabwe", "ZW"},
	{"bolivia", "BO"}, {"brazil", "BR"}, {"congo - kinshasa", "CD"}, {"cameroon", "CM"},
	{"colombia", "CO"}, {"cuba", "CU"}, {"dominican republic", "DO"}, {"ethiopia", "ET"},
	{"indonesia", "ID"}, {"india", "IN"}, {"jamaica", "JM"}, {"kenya", "KE"},
	{"cambodia", "KH"}, {"myanmar (burma)", "MM"}, {"mexico", "MX"}, {"mozambique", "MZ"},
	{"papua new guinea", "PG"}, {"philippines", "PH"}, {"rwanda", "RW"}, {"tanzania", "TZ"},
	{"united states", "US"}, {"yemen", "YE"}, {"zambia", "ZM"}, {"zimbabwe", "ZW"},
}

var nameToCode = func() map[string]string {
	m := make(map[string]string, len(countryNames))
	for _, cn := range countryNames {
		if _, ok := m[cn.name]; !ok {
			m[cn.name] = cn.code
		}
	}
	return m
}()

// mapOriginToCode ports lib/coffee-countries.js's mapOriginToCode(text):
// exact (trimmed, lowercased) match against the localized-name table, else "".
func mapOriginToCode(text string) string {
	return nameToCode[strings.ToLower(strings.TrimSpace(text))]
}

// isCountryLetter ports coffee-countries.js's `isLetter = c => /[a-zäöüß]/.test(c)`
// (the text is already lowercased before this runs) — note it deliberately
// excludes accented Latin letters like the 'é' in "côte d’ivoire".
func isCountryLetter(c byte) bool {
	if c >= 'a' && c <= 'z' {
		return true
	}
	// ä ö ü ß are 2-byte UTF-8 sequences; a bare byte can only be a
	// continuation or lead byte, never a full rune. Node's regex tests one
	// JS char (UTF-16 code unit) at a time, but every name in the table that
	// this boundary check runs against a preceding/following character for is
	// ASCII at its edges — so a byte-level ASCII check matches Node's
	// behavior for every real input. Non-ASCII bytes are treated as
	// non-letter, exactly as Node's regex would for a lone surrogate.
	return false
}

// findCountriesInText ports lib/coffee-countries.js's findCountriesInText(text, maxCount=3):
// scans lowercased prose for the localized country names, returns distinct
// codes in first-appearance order, and treats "more than maxCount distinct
// matches" as boilerplate noise (returns nil).
func findCountriesInText(text string, maxCount int) []string {
	if maxCount == 0 {
		maxCount = 3
	}
	if text == "" {
		return nil
	}
	lower := " " + strings.ToLower(text) + " "
	firstIdx := map[string]int{}
	for _, cn := range countryNames {
		name := cn.name
		idx := strings.Index(lower, name)
		for idx != -1 {
			var before, after, after2 byte
			if idx-1 >= 0 {
				before = lower[idx-1]
			}
			if idx+len(name) < len(lower) {
				after = lower[idx+len(name)]
			}
			if idx+len(name)+1 < len(lower) {
				after2 = lower[idx+len(name)+1]
			}
			boundaryOk := !isCountryLetter(before) &&
				(!isCountryLetter(after) || (after == 's' && !isCountryLetter(after2)))
			if boundaryOk {
				if cur, ok := firstIdx[cn.code]; !ok || idx < cur {
					firstIdx[cn.code] = idx
				}
				break
			}
			next := strings.Index(lower[idx+1:], name)
			if next == -1 {
				idx = -1
			} else {
				idx = idx + 1 + next
			}
		}
	}
	if len(firstIdx) == 0 {
		return nil
	}
	// distinct codes ordered by earliest match position; a stable order for
	// equal positions is impossible (two codes can't share a byte offset),
	// so a plain position sort is enough.
	order := make([]string, 0, len(firstIdx))
	for code := range firstIdx {
		order = append(order, code)
	}
	for i := 1; i < len(order); i++ {
		for j := i; j > 0 && firstIdx[order[j-1]] > firstIdx[order[j]]; j-- {
			order[j-1], order[j] = order[j], order[j-1]
		}
	}
	if len(order) >= 1 && len(order) <= maxCount {
		return order
	}
	return nil
}
