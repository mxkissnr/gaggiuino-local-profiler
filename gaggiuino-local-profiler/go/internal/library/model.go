package library

import (
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// Entity is one library item (bean/grinder/basket/puckScreen/recipe/milk),
// exactly like shots.Shot: a map, not a struct, because the Node original
// (routes/library/*.js) never declares a fixed shape either — it reads and
// writes plain JS objects straight out of/into the `library` table's single
// JSON blob (see repository.go). Using a map here reproduces that byte-for-
// byte instead of risking a struct-tag typo silently dropping or renaming a
// field the frontend/openapi.yaml contract depends on.
type Entity = map[string]any

// Library mirrors LibraryRepository.js's getLibrary() return shape exactly,
// including its `?? []` fallback: every collection is always a non-nil
// (possibly empty) slice, never nil/JSON null, both fresh from a new install
// (no `library` row yet) and after JSON-decoding a stored blob that's
// missing a key added in a later app version.
type Library struct {
	Beans       []Entity `json:"beans"`
	Grinders    []Entity `json:"grinders"`
	Recipes     []Entity `json:"recipes"`
	Milks       []Entity `json:"milks"`
	Baskets     []Entity `json:"baskets"`
	PuckScreens []Entity `json:"puckScreens"`
}

// newLibrary returns the zero-value shape GetLibrary falls back to.
func newLibrary() Library {
	return Library{
		Beans:       []Entity{},
		Grinders:    []Entity{},
		Recipes:     []Entity{},
		Milks:       []Entity{},
		Baskets:     []Entity{},
		PuckScreens: []Entity{},
	}
}

// newID mirrors every routes/library/*.js create handler's `id: Date.now()`
// — a millisecond-epoch timestamp used as the entity id. Node's version can
// theoretically return the same value for two calls inside one millisecond
// too, but a real HTTP round trip between separate requests makes that
// practically impossible. Go's in-process request handling (and the test
// suite in particular, which drives handlers directly via httptest with no
// network hop) can issue two consecutive newID() calls within the same
// millisecond routinely, which produced real bag/portion id collisions and
// a downstream panic (see deleteBag). lastID ratchets the clock forward so
// every call returns a strictly increasing value, eliminating collisions
// without changing the value returned for the common case where enough
// real time has elapsed between calls.
var lastID int64

func newID() int64 {
	for {
		prev := atomic.LoadInt64(&lastID)
		next := time.Now().UnixMilli()
		if next <= prev {
			next = prev + 1
		}
		if atomic.CompareAndSwapInt64(&lastID, prev, next) {
			return next
		}
	}
}

// reserveID mirrors Node's `Date.now() + 1` (routes/library/beans.js's
// initial-bag id, deliberately offset from the bean's own id): it hands back
// a manually computed id but still ratchets newID's clock forward past it,
// so a later newID() call in the same request or the next one can never
// collide with it.
func reserveID(id int64) int64 {
	for {
		prev := atomic.LoadInt64(&lastID)
		if id <= prev || atomic.CompareAndSwapInt64(&lastID, prev, id) {
			return id
		}
	}
}

// idOf reads e[key] as an int64 regardless of whether it arrived as an
// int64 (an Entity built by this package in the current request, e.g. a
// freshly created bean before its first JSON round trip) or a float64 (an
// Entity that came back out of encoding/json, e.g. anything read via
// Repository.GetLibrary) — both are legitimate depending on how far the
// value has traveled, and every id comparison in this package needs both to
// compare equal.
func idOf(e Entity, key string) (int64, bool) {
	switch v := e[key].(type) {
	case int64:
		return v, true
	case float64:
		return int64(v), true
	case int:
		return int64(v), true
	}
	return 0, false
}

// jsParseInt ports JS's parseInt(s, 10) — see shots/handlers.go's copy of
// the same function for the full rationale. Duplicated rather than shared
// across internal/shots and internal/library, same call as shots' own
// toNativeShotID duplication (see shots/model.go): these are small enough
// that a shared package isn't worth the coupling yet.
func jsParseInt(s string) (int64, bool) {
	i, n := 0, len(s)
	for i < n {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			i++
			continue
		}
		break
	}
	start := i
	if i < n && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digitsStart := i
	for i < n && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == digitsStart {
		return 0, false
	}
	v, err := strconv.ParseInt(s[start:i], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseIDParam ports routes/library/*.js's bare `parseInt(req.params.id, 10)`
// — unlike shots' parseID, there's no MAX_SHOT_ID range check or "invalid id
// -> 400" branch anywhere in routes/library/*.js: an unparseable id just
// becomes a NaN that never matches any entity's real id, so every route
// here treats it identically to a valid-but-nonexistent id (a 404, or a
// 200/created-object response entirely unaffected by it). noMatch reports
// true for a param that can never match any real (positive, Date.now()-
// scale) entity id, standing in for JS's `x === NaN` always being false.
func parseIDParam(param string) (id int64, noMatch bool) {
	v, ok := jsParseInt(param)
	if !ok {
		return 0, true
	}
	return v, false
}

var leadingFloatRe = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`)

// jsParseFloat ports JS's parseFloat(v): a number is returned as-is (NaN is
// "not ok", mirroring parseFloat(NaN) -> NaN); a string is parsed against
// its longest leading float literal ("12.5abc" -> 12.5, ok); anything else
// (including a JSON null, bool, object, array) is "not ok", same as
// parseFloat(non-string-non-number) coercing its argument to a NaN-yielding
// string.
func jsParseFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		if t != t { // NaN
			return 0, false
		}
		return t, true
	case string:
		trimmed := strings.TrimLeft(t, " \t\n\r\v\f")
		m := leadingFloatRe.FindString(trimmed)
		if m == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(m, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// jsParseIntLoose ports JS's parseInt(v, 10) where v may already be a
// number (altitude_m/holeCount-style fields the frontend can send as either
// a JSON number or a string) — parseInt on a number argument stringifies it
// first, which for the integer values every caller here actually sends is
// the same as just truncating toward zero.
func jsParseIntLoose(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		if t != t { // NaN
			return 0, false
		}
		return int64(t), true
	case string:
		return jsParseInt(t)
	}
	return 0, false
}

// trimMax ports the `(v, max) => typeof v === 'string' ? v.trim().slice(0,
// max) : ”` helper repeated (with small variations) across
// routes/library/*.js's create handlers: non-string input becomes "".
// Truncation is done on bytes with a UTF-8 boundary guard rather than JS's
// UTF-16-code-unit .slice() — an intentional, documented divergence: exact
// UTF-16 parity would need a much heavier rune/surrogate-pair-aware
// truncator for a difference that only shows up on non-Latin input past the
// max-length boundary, which every field here sets generously (200-2000).
func trimMax(v any, max int) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	return truncateUTF8(s, max)
}

// trimMaxOrUndefined ports the update-handler variant of trimMax:
// `(v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined`.
// present reports whether the field participates at all in a JS `!==
// undefined` gate; when the caller-supplied value isn't a string, this
// still returns present=true (the key WAS in the body) with an empty
// string, rather than trying to reproduce JS's "assign undefined -> key
// dropped from the eventual JSON.stringify" behavior, which no legitimate
// client (bound by openapi.yaml's Bean/Grinder/... schemas) ever triggers.
func trimMaxOrUndefined(body Entity, key string, max int) (value string, present bool) {
	v, ok := body[key]
	if !ok {
		return "", false
	}
	return trimMax(v, max), true
}

// enumStringField reads body[key] and validates it against allowed,
// mirroring the Node original's `if (v && !ALLOWED.has(v)) return 400`
// (routes/library/{baskets,puckscreens}.js) — with one deliberate,
// stricter divergence fixed under #901: the Node check only rejects a
// *truthy* mismatch, so a non-string JSON value (e.g. `{"wallType": 5}`)
// is falsy-ish only by accident and actually sails through as `undefined`
// via optional chaining in places, while here ANY key present in the body
// whose value isn't a string is rejected outright rather than silently
// coerced to the Go zero value "" (which used to bypass validation
// entirely — a present-but-empty value and an absent key were
// indistinguishable). present reports whether key existed in body at all,
// so callers (the update handlers) can tell "not provided, leave
// unchanged" apart from "provided and valid".
func enumStringField(body Entity, key string, allowed map[string]bool) (value string, present bool, ok bool) {
	v, present := body[key]
	if !present {
		return "", false, true
	}
	s, isString := v.(string)
	if !isString {
		return "", true, false
	}
	if s != "" && !allowed[s] {
		return "", true, false
	}
	return s, true, true
}

func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}

// floatOrNilFalsy ports the extremely common `parseFloat(v) || null` idiom:
// JS's `||` treats both NaN (unparseable) and 0 as falsy, so an explicit
// zero collapses to null exactly like a garbage value would — a real JS
// quirk this package reproduces rather than "fixes", since routes/library/
// *.js's own PUT handlers rely on it (e.g. re-PUTting stock_g: 0 stores
// null, not 0).
func floatOrNilFalsy(v any) any {
	f, ok := jsParseFloat(v)
	if !ok || f == 0 {
		return nil
	}
	return f
}

// floatOrZero ports the `parseFloat(v) || 0` idiom (milk stockMl fields).
func floatOrZero(v any) float64 {
	f, ok := jsParseFloat(v)
	if !ok {
		return 0
	}
	return f
}

// boolOf ports JS's `!!v` truthiness coercion for the handful of fields
// (decaf, milk request bodies, ...) that use it directly.
func boolOf(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case nil:
		return false
	default:
		return true // any other present, non-nil value (object/array) is truthy in JS
	}
}

// strOrNull ports the extremely common `bean.field || null` read-side
// idiom used throughout getBeansInfo/getActiveBeans-style projections:
// an empty/missing/falsy string becomes JSON null instead of "".
func strOrNull(e Entity, key string) any {
	v, _ := e[key].(string)
	if v == "" {
		return nil
	}
	return v
}

// bagsOf reads bean["bags"] as a []any — nested arrays inside an Entity are
// always stored as []any (elements are Entity/map[string]any), whether they
// arrived via encoding/json (Repository.GetLibrary) or were just built by a
// handler in this same request, so every reader in this package can rely on
// this one representation instead of juggling both []any and []Entity.
func bagsOf(bean Entity) []any {
	bags, _ := bean["bags"].([]any)
	return bags
}

// activeBag ports the `bags.length ? bags[bags.length-1] : null` idiom
// (the most-recently-pushed bag is always "active").
func activeBag(bean Entity) Entity {
	bags := bagsOf(bean)
	if len(bags) == 0 {
		return nil
	}
	last, _ := bags[len(bags)-1].(Entity)
	return last
}
