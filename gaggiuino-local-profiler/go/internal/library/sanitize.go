package library

import (
	"math"
	"net/url"
	"regexp"
	"strings"
)

// This file ports the individual field sanitizers from lib/sanitize-bean.js
// that routes/library/beans.js's/baskets.js's own POST/PUT handlers call
// directly. The "resanitize a whole restored entity" wrappers
// (SanitizeBeanFields/SanitizeGrinderFields/SanitizeRecipeFields/
// SanitizeMilkFields/SanitizeBasketFields/SanitizePuckScreenFields) live in
// restore_sanitize.go instead (Phase 1f, #901) — their only caller is the
// backup domain's POST /api/restore (internal/backup), a different
// package, so they're exported there and kept in their own file rather
// than mixed into this one.

var isoAlpha2Re = regexp.MustCompile(`^[A-Z]{2}$`)

// sanitizeOrigin ports sanitizeOrigin(v): an ISO 3166-1 alpha-2 code or "".
func sanitizeOrigin(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	code := strings.ToUpper(strings.TrimSpace(s))
	if isoAlpha2Re.MatchString(code) {
		return code
	}
	return ""
}

// sanitizeOrigins ports sanitizeOrigins(v): blend-capable origins array,
// deduped by code, capped at 5.
func sanitizeOrigins(v any) []any {
	arr, ok := v.([]any)
	if !ok {
		return []any{}
	}
	seen := map[string]bool{}
	out := []any{}
	for _, item := range arr {
		m, _ := item.(Entity)
		var codeSrc any
		if m != nil {
			codeSrc = m["code"]
		}
		code := sanitizeOrigin(codeSrc)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		entry := Entity{"code": code}
		if m != nil {
			if pv, present := m["percent"]; present && pv != nil && pv != "" {
				if n, ok := jsParseFloat(pv); ok && n >= 0 && n <= 100 {
					entry["percent"] = math.Round(n*10) / 10
				}
			}
		}
		out = append(out, entry)
		if len(out) >= 5 {
			break
		}
	}
	return out
}

var roastTypes = map[string]bool{"espresso": true, "filter": true, "omni": true}

func sanitizeRoastType(v any) string {
	s, ok := v.(string)
	if ok && roastTypes[s] {
		return s
	}
	return ""
}

var speciesSet = map[string]bool{"Arabica": true, "Robusta": true, "Liberica": true, "Blend": true}

func sanitizeSpecies(v any) string {
	s, ok := v.(string)
	if ok && speciesSet[s] {
		return s
	}
	return ""
}

var categorySet = map[string]bool{"speciality": true, "normal": true}

func sanitizeCategory(v any) string {
	s, ok := v.(string)
	if ok && categorySet[s] {
		return s
	}
	return "normal"
}

// sanitizeFlavors ports sanitizeFlavors(v): short tag chips, deduped
// case-insensitively, capped at 20.
func sanitizeFlavors(v any) []any {
	arr, ok := v.([]any)
	if !ok {
		return []any{}
	}
	seen := map[string]bool{}
	out := []any{}
	for _, item := range arr {
		str, ok := item.(string)
		if !ok {
			continue
		}
		trimmed := truncateUTF8(strings.TrimSpace(str), 50)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, trimmed)
		if len(out) >= 20 {
			break
		}
	}
	return out
}

// sanitizeEnabled ports sanitizeEnabled(v): missing/undefined means enabled
// (true) — only an explicit false-ish value turns it off.
func sanitizeEnabled(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t != "false" && t != "0"
	case float64:
		return t != 0
	}
	return true
}

func sanitizeAltitude(v any) any {
	n, ok := jsParseIntLoose(v)
	if ok && n >= 0 && n <= 3000 {
		return n
	}
	return nil
}

func sanitizePrice(v any) any {
	n, ok := jsParseFloat(v)
	if ok && n >= 0 && n <= 500 {
		return math.Round(n*100) / 100
	}
	return nil
}

func sanitizeBrewTemp(v any) any {
	n, ok := jsParseFloat(v)
	if ok && n >= 80 && n <= 100 {
		return math.Round(n*10) / 10
	}
	return nil
}

func sanitizeBrewTime(v any) any {
	n, ok := jsParseIntLoose(v)
	if ok && n >= 5 && n <= 300 {
		return n
	}
	return nil
}

// safeURL ports safeUrl(v): only a well-formed http(s) URL survives.
func safeURL(v any) string {
	s, ok := v.(string)
	if !ok || s == "" {
		return ""
	}
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}

// sanitizeFrozenPortions ports sanitizeFrozenPortions(v) (#472): dated
// frozen-portion batches within a bag, capped at 50 entries; an entry
// missing a required field is dropped entirely (`.filter(Boolean)`).
func sanitizeFrozenPortions(v any) []any {
	arr, ok := v.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for i, item := range arr {
		if i >= 50 {
			break
		}
		fp, _ := item.(Entity)
		if fp == nil {
			continue
		}
		frozenAtF, frozenOK := fp["frozenAt"].(float64)
		if !frozenOK || frozenAtF == 0 {
			continue
		}
		frozenAt := int64(frozenAtF)
		portionCount, pcOK := jsParseIntLoose(fp["portionCount"])
		portionWeight, pwOK := jsParseFloat(fp["portionWeight_g"])
		if !pcOK || !(portionCount > 0 && portionCount <= 500) {
			continue
		}
		if !pwOK || !(portionWeight > 0 && portionWeight <= 2000) {
			continue
		}
		var thawedAt any
		if thawedAtF, ok := fp["thawedAt"].(float64); ok && thawedAtF >= frozenAtF {
			thawedAt = int64(thawedAtF)
		}
		remainingCount := portionCount
		if rc, ok := jsParseIntLoose(fp["remainingCount"]); ok {
			remainingCount = rc
			if remainingCount < 0 {
				remainingCount = 0
			}
			if remainingCount > portionCount {
				remainingCount = portionCount
			}
		}
		var id any
		if idv, ok := fp["id"]; ok && idv != nil {
			id = idv
		} else {
			id = frozenAt
		}
		entry := Entity{
			"id": id, "frozenAt": frozenAt, "portionCount": portionCount,
			"portionWeight_g": math.Round(portionWeight*10) / 10,
			"remainingCount":  remainingCount,
		}
		if thawedAt != nil {
			entry["thawedAt"] = thawedAt
		}
		out = append(out, entry)
	}
	return out
}
