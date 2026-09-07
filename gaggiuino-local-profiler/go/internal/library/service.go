package library

import (
	"log"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports the LibraryService.js methods routes/library/*.js's
// handlers actually call: getBeansInfo, computeGrinderWearStats,
// upsertKnownGrindSetting, setBeanImage. Everything else on
// LibraryService.js (maintenance/*, migrate*, checkLowStockNotify,
// resolveBeanForAnnotation/findBeanByName) is out of this phase's scope —
// see doc.go. computeBeanRemaining/getActiveBeans/getActiveMilks/
// deductMilkByName landed in Phase 1f (orders_support.go); geocodeBean
// landed in Phase 2g (geo.go).

// GetBeansInfo ports LibraryService.js's getBeansInfo() — lightweight bean
// metadata for GET /api/library/beans-info, a contract glp-integration's
// proxy and glp-lovelace-card both consume directly (see the Phase 1d task
// description), so field names/nullability here must match byte-for-byte.
func GetBeansInfo(lib Library) []Entity {
	out := make([]Entity, 0, len(lib.Beans))
	for _, bean := range lib.Beans {
		bag := activeBag(bean)
		var roastDate any
		if bag != nil {
			if v, _ := bag["roastDate"].(string); v != "" {
				roastDate = v
			}
		}
		if roastDate == nil {
			roastDate = strOrNull(bean, "roastDate")
		}
		var flavors any
		if fl, ok := bean["flavors"].([]any); ok && len(fl) > 0 {
			flavors = fl
		}
		category, _ := bean["category"].(string)
		if category == "" {
			category = "normal"
		}
		out = append(out, Entity{
			"id":        bean["id"],
			"name":      bean["name"],
			"roaster":   strOrNull(bean, "roaster"),
			"origin":    strOrNull(bean, "origin"),
			"variety":   strOrNull(bean, "variety"),
			"species":   strOrNull(bean, "species"),
			"category":  category,
			"process":   strOrNull(bean, "process"),
			"flavors":   flavors,
			"roastType": strOrNull(bean, "roastType"),
			"hasImage":  boolOf(bean["image"]),
			"roastDate": roastDate,
			"decaf":     boolOf(bean["decaf"]),
		})
	}
	return out
}

// parseJSDate ports `new Date(str).getTime()` for the two string shapes
// burrsResetAt/purchaseDate ever actually hold: a plain "YYYY-MM-DD" date
// (from the grinder create/update routes' own `s(v,10)` truncation) or a
// full ISO timestamp (from POST .../reset-burrs' `new Date().toISOString()`).
// ok=false mirrors JS's NaN result for anything else — every "since burrs"
// comparison below then always evaluates false for it, same as a NaN
// comparison in JS, rather than this package guessing a fallback timestamp.
func parseJSDate(s string) (ms int64, ok bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// ComputeGrinderWearStats ports LibraryService.js's computeGrinderWearStats:
// shots/grams ground on this grinder since its last burr swap (or
// purchase), matched by annotated grinder name, case-insensitive.
// shotsRepo is internal/shots' Repository — the shots domain doesn't expose
// a Service for this cross-domain read, so this package talks to its
// Repository directly, the same way ShotRepository.js's findAllExcludingTrash
// is called directly from LibraryService.js rather than through
// ShotService.js.
func ComputeGrinderWearStats(shotsRepo *shots.Repository, grinder Entity) (shotsSinceBurrs int, gramsSinceBurrs float64, err error) {
	allShots, err := shotsRepo.FindAllExcludingTrash()
	if err != nil {
		return 0, 0, err
	}
	s, g := ComputeGrinderWearFrom(allShots, grinder)
	return s, g, nil
}

// ComputeGrinderWearFrom is ComputeGrinderWearStats' pure core: one
// grinder's burr wear against an already-loaded shot list. Enriching every
// grinder for GET /api/library (and the /grinders web page) used to call
// ComputeGrinderWearStats per grinder, so a 3-grinder library scanned the
// whole shot history 3× (#951); those call sites now load the shots once
// and fold every grinder through this in a single pass.
func ComputeGrinderWearFrom(allShots []shots.Shot, grinder Entity) (shotsSinceBurrs int, gramsSinceBurrs float64) {
	name, _ := grinder["name"].(string)
	name = lowerOrEmpty(name)

	var resetTs int64
	resetValid := true
	if resetStr, _ := grinder["burrsResetAt"].(string); resetStr != "" {
		ms, ok := parseJSDate(resetStr)
		if !ok {
			resetValid = false // unparseable -> NaN comparison -> never matches, see parseJSDate
		} else {
			resetTs = ms
		}
	}
	if !resetValid {
		return 0, 0
	}

	var grams float64
	for _, shot := range allShots {
		ann, _ := shot["annotation"].(map[string]any)
		grinderName := ""
		if ann != nil {
			grinderName, _ = ann["grinder"].(string)
		}
		if lowerOrEmpty(grinderName) != name {
			continue
		}
		ts, _ := shot["timestamp"].(int64)
		if ts*1000 <= resetTs {
			continue
		}
		shotsSinceBurrs++
		if ann != nil {
			if dose, ok := jsParseFloat(ann["dose"]); ok {
				grams += dose
			}
		}
	}
	return shotsSinceBurrs, roundTo1(grams)
}

// roundTo1 ports `Math.round(gramsSinceBurrs * 10) / 10` — grams ground is
// never negative in practice (parseFloat(dose)||0, doses are non-negative),
// so plain round-half-up (matching Math.round's own tie-breaking) is enough.
func roundTo1(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}

// lowerOrEmpty ports `String(...).toLowerCase()` — strings.ToLower is
// Unicode-case-folding-aware like JS's toLowerCase(), unlike a plain A-Z
// byte-range fold, which left non-ASCII grinder names (e.g. "Éureka",
// "Mühle") comparing unequal to themselves (#901).
func lowerOrEmpty(s string) string {
	return strings.ToLower(s)
}

// UpsertKnownGrindSetting ports LibraryService.js's upsertKnownGrindSetting
// (#310, Guided Dial-In): remembers the winning (grinder, grindSetting)
// combo for a bean, newest first, capped at 10. Returns (bean, false) when
// beanID doesn't match any bean, matching the Node original's null return.
func UpsertKnownGrindSetting(lib *Library, beanID int64, grinder, grindSetting string) (Entity, bool) {
	for i, bean := range lib.Beans {
		id, ok := idOf(bean, "id")
		if !ok || id != beanID {
			continue
		}
		existing, _ := bean["knownGrindSettings"].([]any)
		key := lowerOrEmpty(grinder)
		filtered := make([]any, 0, len(existing))
		for _, e := range existing {
			em, _ := e.(Entity)
			g, _ := em["grinder"].(string)
			if lowerOrEmpty(g) == key {
				continue
			}
			filtered = append(filtered, e)
		}
		entry := Entity{"grinder": grinder, "grindSetting": grindSetting, "updatedAt": time.Now().UnixMilli()}
		updated := append([]any{entry}, filtered...)
		if len(updated) > 10 {
			updated = updated[:10]
		}
		bean["knownGrindSettings"] = updated
		lib.Beans[i] = bean
		return bean, true
	}
	return nil, false
}

// ToggleBeanActive ports routes/library/beans.js's POST .../toggle-active
// handler body (#578): `bean.enabled === false ? true : false` — anything
// other than the exact boolean false (including absent/undefined) flips to
// false. Exported (unlike this file's other helpers) so internal/web's
// Beans page can drive the same enabled/disabled flag through the same
// read-mutate-save round trip its REST counterpart (handlers_beans.go's
// toggleBeanActive, which now calls this too) uses, rather than
// reimplementing the flip. found is false when id matches no bean, mirroring
// the REST handler's 404. lib is the same already-read (and, on success,
// already-saved) Library this function fetched internally — callers that
// need the rest of the library alongside the toggled bean (internal/web's
// toggleBeanActiveAction, which re-renders a row from lib.Beans) reuse it
// instead of issuing their own extra GetLibrary call.
func ToggleBeanActive(repo *Repository, id int64) (bean Entity, lib Library, found bool, err error) {
	lib, err = repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findBeanIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	bean = lib.Beans[idx]
	if b, isBool := bean["enabled"].(bool); isBool && !b {
		bean["enabled"] = true
	} else {
		bean["enabled"] = false
	}
	lib.Beans[idx] = bean
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	return bean, lib, true, nil
}

// SetBeanImage ports LibraryService.js's setBeanImage: fire-and-forget after
// a bean create with an `imageUrl` field — downloads the image once and
// records its extension on a FRESH read of the library (not the `lib`
// object the create handler already saved), matching the Node original's
// own re-read (the bean may have been edited/deleted by the time this
// finishes). Called from a goroutine by handlers.go's createBean, exactly
// mirroring the Node route's un-awaited `.catch(() => {})` call.
func SetBeanImage(repo *Repository, imageDir string, beanID int64, imageURL string) {
	ext := fetchBeanImage(imageDir, beanID, imageURL)
	if ext == "" {
		return
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		log.Printf("library: setBeanImage: reloading library for bean %d: %v", beanID, err)
		return
	}
	for i, bean := range lib.Beans {
		id, ok := idOf(bean, "id")
		if !ok || id != beanID {
			continue
		}
		if oldExt, _ := bean["image"].(string); oldExt != "" && oldExt != ext {
			img.Delete(imageDir, beanID, oldExt, "")
		}
		bean["image"] = ext
		lib.Beans[i] = bean
		if err := repo.SaveLibrary(lib); err != nil {
			log.Printf("library: setBeanImage: saving library for bean %d: %v", beanID, err)
		}
		return
	}
	// Bean was deleted before the download finished — clean up the orphaned file.
	img.Delete(imageDir, beanID, ext, "")
}
