package shots

import (
	"fmt"
	"math"
	"unicode/utf8"
)

// This file validates the two shot-relevant request bodies (annotations and
// shot defaults) — same fields, nullability and length/range constraints —
// using Go's encoding/json (numbers decode to float64, objects to
// map[string]any). It is not a general-purpose JSON-Schema validator, only
// these two shapes, and it produces the `{ error: 'Validation failed', issues:
// [{path, message}] }` 400 response shape (the message text is descriptive,
// not byte-identical to the original wording: same rules, not a literal
// translation).

// ValidationIssue is one `{ path, message }` validation failure.
type ValidationIssue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// isJSONInt reports whether f has no fractional part (an integer JSON number).
func isJSONInt(f float64) bool {
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f)
}

// checkString validates body[key] as a string of at most maxLen characters
// (runes, not bytes: "ü" counts once, #1620), with the
// schema's nullability semantics: absent is always fine (optional), explicit
// null is fine only when nullable is true.
func checkString(issues *[]ValidationIssue, body map[string]any, key string, maxLen int, nullable bool) {
	v, present := body[key]
	if !present {
		return
	}
	if v == nil {
		if !nullable {
			*issues = append(*issues, ValidationIssue{key, "expected string, received null"})
		}
		return
	}
	s, ok := v.(string)
	if !ok {
		*issues = append(*issues, ValidationIssue{key, "expected string"})
		return
	}
	if utf8.RuneCountInString(s) > maxLen {
		*issues = append(*issues, ValidationIssue{key, fmt.Sprintf("String must contain at most %d character(s)", maxLen)})
	}
}

// checkInt validates body[key] as an integer JSON number, nullable per the
// nullable param — used for every *Id field in both schemas.
func checkInt(issues *[]ValidationIssue, body map[string]any, key string, nullable bool) {
	v, present := body[key]
	if !present {
		return
	}
	if v == nil {
		if !nullable {
			*issues = append(*issues, ValidationIssue{key, "expected number, received null"})
		}
		return
	}
	f, ok := v.(float64)
	if !ok {
		*issues = append(*issues, ValidationIssue{key, "expected number"})
		return
	}
	if !isJSONInt(f) {
		*issues = append(*issues, ValidationIssue{key, "expected integer, received float"})
	}
}

// checkNumber validates body[key] as a JSON number, nullable.
func checkNumber(issues *[]ValidationIssue, body map[string]any, key string, nullable bool) {
	v, present := body[key]
	if !present {
		return
	}
	if v == nil {
		if !nullable {
			*issues = append(*issues, ValidationIssue{key, "expected number, received null"})
		}
		return
	}
	if _, ok := v.(float64); !ok {
		*issues = append(*issues, ValidationIssue{key, "expected number"})
	}
}

// ValidateAnnotation validates an annotation body against the annotation
// schema. Unknown keys are passed through — every key besides the ones checked
// here (including the scorer's own ann.dose/ann.tds reads, which this schema
// never declares at all) is left untouched in body, valid or not; this
// function only ever appends issues, never mutates or strips body.
func ValidateAnnotation(body map[string]any) []ValidationIssue {
	var issues []ValidationIssue
	checkString(&issues, body, "coffee", 200, false)
	checkString(&issues, body, "grindSetting", 50, false)
	checkString(&issues, body, "notes", 2000, false)
	checkString(&issues, body, "drinkType", 50, true)
	checkInt(&issues, body, "milkType", true)
	checkInt(&issues, body, "rating", true)
	if v, present := body["rating"]; present && v != nil {
		if f, ok := v.(float64); ok && isJSONInt(f) && (f < 1 || f > 5) {
			issues = append(issues, ValidationIssue{"rating", "Number must be between 1 and 5"})
		}
	}
	checkNumber(&issues, body, "score", true)
	checkInt(&issues, body, "recipeId", true)
	checkInt(&issues, body, "beanId", true)
	checkInt(&issues, body, "beanBagId", true)
	checkInt(&issues, body, "frozenPortionId", true)
	checkInt(&issues, body, "basketId", true)
	checkInt(&issues, body, "puckScreenId", true)
	checkBeanMix(&issues, body)
	return issues
}

// checkBeanMix validates the optional `beanMix` annotation key (#1837): absent
// or null for a single-bean shot, otherwise 2-4 parts with a required 1-200
// char coffee name, an optional integer beanId (unique across the parts) and a
// required 1-100 grams share each. The grams are deliberately NOT summed
// against the dose: the dose is the whole shot's output, the parts are how it
// was made up, and a mismatch is a user-visible inconsistency rather than a
// reason to drop the whole annotation (a restore drops any annotation with an
// issue; PatchAnnotation validates only the keys it sets).
func checkBeanMix(issues *[]ValidationIssue, body map[string]any) {
	v, present := body["beanMix"]
	if !present || v == nil {
		return
	}
	list, ok := v.([]any)
	if !ok {
		*issues = append(*issues, ValidationIssue{"beanMix", "expected array"})
		return
	}
	if len(list) < minBeanMixParts || len(list) > maxBeanMixParts {
		*issues = append(*issues, ValidationIssue{"beanMix", fmt.Sprintf("Array must contain %d to %d items", minBeanMixParts, maxBeanMixParts)})
		return
	}
	seenBeanIDs := make(map[int64]bool, len(list))
	for i, raw := range list {
		path := fmt.Sprintf("beanMix[%d]", i)
		part, ok := raw.(map[string]any)
		if !ok {
			*issues = append(*issues, ValidationIssue{path, "expected object"})
			continue
		}
		checkBeanMixCoffee(issues, part, path+".coffee")
		checkBeanMixBeanID(issues, part, path+".beanId", seenBeanIDs)
		checkBeanMixGrams(issues, part, path+".grams")
	}
}

// checkBeanMixCoffee validates one part's required coffee name.
func checkBeanMixCoffee(issues *[]ValidationIssue, part map[string]any, path string) {
	v, present := part["coffee"]
	if !present || v == nil {
		*issues = append(*issues, ValidationIssue{path, "Required"})
		return
	}
	s, ok := v.(string)
	if !ok {
		*issues = append(*issues, ValidationIssue{path, "expected string"})
		return
	}
	if utf8.RuneCountInString(s) < 1 {
		*issues = append(*issues, ValidationIssue{path, "String must contain at least 1 character(s)"})
	}
	if utf8.RuneCountInString(s) > 200 {
		*issues = append(*issues, ValidationIssue{path, "String must contain at most 200 character(s)"})
	}
}

// checkBeanMixBeanID validates one part's optional beanId and records it in
// seenBeanIDs, reporting the second and later occurrence of a non-null id.
func checkBeanMixBeanID(issues *[]ValidationIssue, part map[string]any, path string, seenBeanIDs map[int64]bool) {
	v, present := part["beanId"]
	if !present || v == nil {
		return
	}
	f, ok := v.(float64)
	if !ok {
		*issues = append(*issues, ValidationIssue{path, "expected number"})
		return
	}
	if !isJSONInt(f) {
		*issues = append(*issues, ValidationIssue{path, "expected integer, received float"})
		return
	}
	id, ok := jsonInt64(f)
	if !ok {
		return
	}
	if seenBeanIDs[id] {
		*issues = append(*issues, ValidationIssue{path, "Duplicate bean in beanMix"})
	}
	seenBeanIDs[id] = true
}

// checkBeanMixGrams validates one part's required grams share: a JSON number
// greater than 0 and at most 100.
func checkBeanMixGrams(issues *[]ValidationIssue, part map[string]any, path string) {
	v, present := part["grams"]
	if !present || v == nil {
		*issues = append(*issues, ValidationIssue{path, "Required"})
		return
	}
	f, ok := v.(float64)
	if !ok {
		*issues = append(*issues, ValidationIssue{path, "expected number"})
		return
	}
	if f <= 0 {
		*issues = append(*issues, ValidationIssue{path, "Number must be greater than 0"})
	} else if f > 100 {
		*issues = append(*issues, ValidationIssue{path, "Number must be less than or equal to 100"})
	}
}

// ValidateShotDefaults validates a shot-defaults body (#654). Unlike the
// annotation schema this one does not pass unknown keys through, but its only
// caller (POST /api/shots/defaults) picks fields by name out of the validated
// body anyway (see handlers.go's shotDefaultsFromBody), so no separate "strip
// unknown keys" step is needed here.
func ValidateShotDefaults(body map[string]any) []ValidationIssue {
	var issues []ValidationIssue
	checkString(&issues, body, "drinkType", 50, true)
	checkString(&issues, body, "coffee", 200, true)
	checkInt(&issues, body, "beanId", true)
	checkInt(&issues, body, "basketId", true)
	checkInt(&issues, body, "puckScreenId", true)
	checkString(&issues, body, "grinder", 200, false)
	if v, present := body["dose"]; present && v != nil {
		f, ok := v.(float64)
		if !ok {
			issues = append(issues, ValidationIssue{"dose", "expected number"})
		} else if f <= 0 {
			issues = append(issues, ValidationIssue{"dose", "Number must be greater than 0"})
		}
	}
	return issues
}
