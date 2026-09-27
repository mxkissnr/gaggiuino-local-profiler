package library

import (
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file holds the shared shot→bean resolution the server-side scorer and
// the achievement checks both use. It used to live in internal/achievements
// (helpers.js's resolveBeanForShot), but internal/shots cannot import
// internal/library (library imports shots), so the one implementation lives
// here and shots receives it through an injected bean source — see
// shots.SetBeanSource. Moving it out of achievements also means the badge
// checks and the score agree by construction instead of by copy.

// ResolveBeanForShot ports helpers.js's resolveBeanForShot: beanId-first,
// coffee-name fallback (case-insensitive). Returns nil when the shot has no
// annotation, or the annotation matches no bean.
func ResolveBeanForShot(shot shots.Shot, beans []Entity) Entity {
	ann, _ := shot["annotation"].(map[string]any)
	if ann == nil {
		return nil
	}
	if raw, present := ann["beanId"]; present && raw != nil {
		if id, ok := beanRefID(raw); ok {
			for _, b := range beans {
				if bid, ok := idOf(b, "id"); ok && bid == id {
					return b
				}
			}
		}
	}
	coffee, _ := ann["coffee"].(string)
	if coffee == "" {
		return nil
	}
	key := strings.ToLower(coffee)
	for _, b := range beans {
		name, _ := b["name"].(string)
		if strings.ToLower(name) == key {
			return b
		}
	}
	return nil
}

// ScoreBean resolves shot's library bean (beanId-first, coffee-name
// fallback) and converts its brewTempC/brewRatio targets into the subset of
// fields shots.CalcShotScoreDetail scores against (#450). A nil result means
// "no bean resolved" — the caller then scores against the generic bands. A
// resolved bean with no targets still yields a non-nil *shots.Bean with nil/
// empty fields, exactly as the achievement checks did before the move.
func ScoreBean(shot shots.Shot, beans []Entity) *shots.Bean {
	resolved := ResolveBeanForShot(shot, beans)
	if resolved == nil {
		return nil
	}
	b := shots.Bean{}
	if t, ok := jsParseFloat(resolved["brewTempC"]); ok && t > 0 {
		b.BrewTempC = &t
	}
	if r, _ := resolved["brewRatio"].(string); r != "" {
		b.BrewRatio = r
	}
	return &b
}

// beanRefID coerces a shot annotation's beanId to int64, accepting every
// numeric shape an annotation carries depending on how far it has traveled
// (an in-memory int64, or the float64 encoding/json produces) — the same
// tolerance idOf gives entity fields.
func beanRefID(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case float64:
		return int64(n), true
	}
	return 0, false
}
