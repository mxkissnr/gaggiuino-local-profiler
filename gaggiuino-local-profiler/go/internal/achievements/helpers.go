package achievements

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// isGlobalMaintenanceTask ports lib/constants.js's isGlobalMaintenanceTask
// (also in internal/maintenance, unexported there) — waterfilter and
// grinder_* tasks track shared equipment and always live under machine 1.
func isGlobalMaintenanceTask(key string) bool {
	return key == "waterfilter" || strings.HasPrefix(key, "grinder_")
}

// This file ports lib/achievements/helpers.js: the small pure helpers the
// badge check() functions in registry.go share. Kept separate from the
// registry itself so that file stays a readable data list, exactly like
// the Node split.

// maxShotID mirrors lib/constants.js's MAX_SHOT_ID (shots.MaxShotID) — real
// shot ids never exceed it, demo shots are namespaced far above.
const maxShotID = shots.MaxShotID

// demoIDBase mirrors lib/demo-seed.js's DEMO_ID_BASE (internal/system's
// demoIDBase, unexported there — every domain package redefines the
// constants it needs, same pattern as internal/system/version.go's
// glpVersion).
const demoIDBase = 900_000_000

// isDemoShot ports helpers.js's isDemoShot: a shot whose id is above the
// real-id ceiling is a seeded demo shot.
func isDemoShot(shot shots.Shot) bool {
	id, ok := asInt64(shot["id"])
	if !ok {
		return true // matches `!shot` / missing-id -> treated as demo/excluded
	}
	return id > maxShotID
}

// isDemoLibraryID ports helpers.js's isDemoLibraryId.
func isDemoLibraryID(id int64) bool {
	return id >= demoIDBase && id < demoIDBase*2
}

// stddev ports helpers.js's stddev (population standard deviation, 0 for
// fewer than 2 samples).
func stddev(vals []float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	mean := sum / float64(len(vals))
	var acc float64
	for _, v := range vals {
		acc += (v - mean) * (v - mean)
	}
	return math.Sqrt(acc / float64(len(vals)))
}

// detectPreinfusionSeconds ports helpers.js's detectPreinfusionSeconds:
// preinfusion duration in seconds, or nil when no clear transition shows.
func detectPreinfusionSeconds(times, pressures []float64) *float64 {
	if len(times) == 0 || len(pressures) < 5 {
		return nil
	}
	const thresh = 3.5
	endIdx := -1
	for i := 0; i < len(pressures) && i < len(times); i++ {
		if times[i] >= 1 && pressures[i] >= thresh {
			endIdx = i
			break
		}
	}
	if endIdx <= 0 {
		return nil
	}
	pre := times[endIdx]
	if pre >= 1.5 {
		return &pre
	}
	return nil
}

// hasPressurePlateau ports helpers.js's hasPressurePlateau: true when some
// >= windowSec stretch holds pressure within +/- tolerance bar.
func hasPressurePlateau(times, pressures []float64, windowSec, tolerance float64) bool {
	if len(times) == 0 || len(times) != len(pressures) {
		return false
	}
	lo := 0
	for hi := 0; hi < len(times); hi++ {
		for times[hi]-times[lo] > windowSec {
			lo++
		}
		if times[hi]-times[lo] >= windowSec {
			mn, mx := pressures[lo], pressures[lo]
			for _, p := range pressures[lo : hi+1] {
				if p < mn {
					mn = p
				}
				if p > mx {
					mx = p
				}
			}
			if mx-mn <= tolerance {
				return true
			}
		}
	}
	return false
}

// datapointsScaled reads shot.datapoints[key] as a []float64 with each
// value divided by div — the `(d.timeInShot || []).map(v => v / 10)` idiom
// the registry uses everywhere.
func datapointsScaled(shot shots.Shot, key string, div float64) []float64 {
	dp := shots.DatapointsMap(shot)
	arr, _ := dp[key].([]any)
	out := make([]float64, 0, len(arr))
	for _, x := range arr {
		if f, ok := asFloat64(x); ok {
			out = append(out, f/div)
		}
	}
	return out
}

// finalWeightG ports helpers.js's finalWeightG: max of shotWeight (or
// weight), tenths -> grams.
func finalWeightG(shot shots.Shot) float64 {
	w := datapointsScaled(shot, "shotWeight", 10)
	if len(w) == 0 {
		w = datapointsScaled(shot, "weight", 10)
	}
	mx := 0.0
	for _, v := range w {
		if v > mx {
			mx = v
		}
	}
	return mx
}

// shotRatio ports helpers.js's shotRatio: yield / dose, or nil.
func shotRatio(shot shots.Shot) *float64 {
	ann, _ := shot["annotation"].(map[string]any)
	dose, ok := asFloat64(ann["dose"])
	if !ok || dose <= 0 {
		return nil
	}
	w := finalWeightG(shot)
	if w == 0 {
		return nil
	}
	r := w / dose
	return &r
}

// beanID extracts a library bean's numeric id (int64 or float64 as decoded
// from JSON).
func beanID(bean library.Entity) (int64, bool) {
	return asInt64(bean["id"])
}

// resolveBeanForShot ports helpers.js's resolveBeanForShot: beanId-first,
// coffee-name fallback.
func resolveBeanForShot(shot shots.Shot, beans []library.Entity) library.Entity {
	ann, _ := shot["annotation"].(map[string]any)
	if ann == nil {
		return nil
	}
	if raw, present := ann["beanId"]; present && raw != nil {
		if id, ok := asInt64(raw); ok {
			for _, b := range beans {
				if bid, ok := beanID(b); ok && bid == id {
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

// bagAtShotTime ports helpers.js's bagAtShotTime: which bag of `bean` was
// open at shotTimestampSec.
func bagAtShotTime(bean library.Entity, shotTimestampSec int64) library.Entity {
	bags, _ := bean["bags"].([]any)
	if len(bags) == 0 {
		return nil
	}
	shotMs := shotTimestampSec * 1000
	var candidates []library.Entity
	var all []library.Entity
	for _, b := range bags {
		bag, _ := b.(map[string]any)
		if bag == nil {
			continue
		}
		all = append(all, bag)
		openedAt, _ := asInt64(bag["openedAt"])
		if openedAt <= shotMs {
			candidates = append(candidates, bag)
		}
	}
	pool := candidates
	if len(pool) == 0 {
		pool = all
	}
	if len(pool) == 0 {
		return nil
	}
	best := pool[0]
	bestOpened, _ := asInt64(best["openedAt"])
	for _, bag := range pool[1:] {
		o, _ := asInt64(bag["openedAt"])
		if o > bestOpened {
			best, bestOpened = bag, o
		}
	}
	return best
}

// currentDayStreak ports helpers.js's currentDayStreak: longest run of
// consecutive local calendar days in dateSet ending today or yesterday.
func currentDayStreak(dateSet map[string]bool, nowMS int64) int {
	const dayMS = int64(86_400_000)
	now := time.UnixMilli(nowMS).UTC()
	todayKey := now.Format("2006-01-02")
	yesterdayKey := time.UnixMilli(nowMS - dayMS).UTC().Format("2006-01-02")

	var cursor time.Time
	switch {
	case dateSet[todayKey]:
		cursor = now
	case dateSet[yesterdayKey]:
		cursor = time.UnixMilli(nowMS - dayMS).UTC()
	default:
		return 0
	}
	streak := 0
	for {
		key := cursor.Format("2006-01-02")
		if !dateSet[key] {
			break
		}
		streak++
		cursor = cursor.Add(-24 * time.Hour)
	}
	return streak
}

// textMatchesAny ports helpers.js's textMatchesAny: case-insensitive
// substring match against any keyword.
func textMatchesAny(text string, keywords []string) bool {
	if text == "" {
		return false
	}
	norm := strings.ToLower(text)
	for _, k := range keywords {
		if strings.Contains(norm, k) {
			return true
		}
	}
	return false
}

// maintenanceCleanStreakDays ports helpers.js's maintenanceCleanStreakDays:
// "days without an overdue day-based maintenance task", re-derived from log
// history + current thresholds. See the Node original's doc comment for the
// documented approximation this is.
func maintenanceCleanStreakDays(ctx *Context) int {
	const dayMS = float64(86_400_000)
	var latestResetMS *float64
	nowMS := float64(ctx.Now)

	var firstMachineID int64 = 1
	if len(ctx.Machines) > 0 {
		firstMachineID = ctx.Machines[0].ID
	}

	for task := range ctx.StaticMaintenanceTasks {
		global := isGlobalMaintenanceTask(task)
		var scopeIDs []int64
		if global {
			scopeIDs = []int64{firstMachineID}
		} else {
			for _, m := range ctx.Machines {
				scopeIDs = append(scopeIDs, m.ID)
			}
		}
		for _, machineID := range scopeIDs {
			conf := ctx.MaintenanceConfigByMachine[machineID]
			thresholdDays, ok := asFloat64(taskField(conf, task, "threshold_days"))
			if !ok || thresholdDays == 0 {
				continue
			}
			var stamps []float64
			for _, l := range ctx.MaintenanceLogs {
				if l.Task != task {
					continue
				}
				if !global && l.MachineID != machineID {
					continue
				}
				stamps = append(stamps, float64(l.TS)*1000)
			}
			if len(stamps) == 0 {
				continue
			}
			sortFloats(stamps)

			reset := stamps[0]
			for i := 1; i < len(stamps); i++ {
				if (stamps[i]-stamps[i-1])/dayMS > thresholdDays {
					reset = stamps[i]
				}
			}
			currentGapDays := (nowMS - stamps[len(stamps)-1]) / dayMS
			if currentGapDays > thresholdDays {
				reset = nowMS
			}
			if latestResetMS == nil || reset > *latestResetMS {
				r := reset
				latestResetMS = &r
			}
		}
	}

	if latestResetMS == nil {
		return 0
	}
	return int(math.Floor((nowMS - *latestResetMS) / dayMS))
}

// bagFirstUseAgesDays ports helpers.js's bagFirstUseAgesDays: for every
// (bean, bag) pair brewed at least once, the age in days of the bag's
// roast date at its EARLIEST use.
func bagFirstUseAgesDays(shotList []shots.Shot, beans []library.Entity) []float64 {
	byBean := map[int64][]shots.Shot{}
	order := []int64{}
	for _, shot := range shotList {
		bean := resolveBeanForShot(shot, beans)
		if bean == nil {
			continue
		}
		id, ok := beanID(bean)
		if !ok {
			continue
		}
		if _, seen := byBean[id]; !seen {
			order = append(order, id)
		}
		byBean[id] = append(byBean[id], shot)
	}

	var ages []float64
	for _, id := range order {
		beanShots := byBean[id]
		var bean library.Entity
		for _, b := range beans {
			if bid, ok := beanID(b); ok && bid == id {
				bean = b
				break
			}
		}
		if bean == nil {
			continue
		}
		bags, _ := bean["bags"].([]any)
		type bagRef struct{ bag library.Entity }
		refs := []bagRef{}
		if len(bags) > 0 {
			for _, b := range bags {
				if bm, _ := b.(map[string]any); bm != nil {
					refs = append(refs, bagRef{bm})
				}
			}
		} else {
			refs = append(refs, bagRef{nil})
		}

		for _, ref := range refs {
			var shotsForBag []shots.Shot
			if ref.bag != nil {
				for _, s := range beanShots {
					ts, _ := asInt64(s["timestamp"])
					if sameEntity(bagAtShotTime(bean, ts), ref.bag) {
						shotsForBag = append(shotsForBag, s)
					}
				}
			} else {
				shotsForBag = beanShots
			}
			if len(shotsForBag) == 0 {
				continue
			}
			earliest := shotsForBag[0]
			earliestTS, _ := asInt64(earliest["timestamp"])
			for _, s := range shotsForBag[1:] {
				ts, _ := asInt64(s["timestamp"])
				if ts < earliestTS {
					earliest, earliestTS = s, ts
				}
			}
			raw := ""
			if ref.bag != nil {
				raw, _ = ref.bag["roastDate"].(string)
			}
			if raw == "" {
				raw, _ = bean["roastDate"].(string)
			}
			if raw == "" {
				continue
			}
			roastMS, ok := parseDateMS(raw)
			if !ok {
				continue
			}
			ages = append(ages, (float64(earliestTS)*1000-float64(roastMS))/86_400_000)
		}
	}
	return ages
}

// ── tiny local helpers ─────────────────────────────────────────────────

func asFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int64:
		return float64(n), true
	case int:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}

func taskField(conf map[string]map[string]any, task, key string) any {
	if conf == nil {
		return nil
	}
	t := conf[task]
	if t == nil {
		return nil
	}
	return t[key]
}

func sortFloats(s []float64) {
	sort.Float64s(s)
}

func sameEntity(a, b library.Entity) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ai, aok := asInt64(a["id"])
	bi, bok := asInt64(b["id"])
	if aok && bok {
		return ai == bi
	}
	// bags without ids: fall back to pointer identity via map address is
	// impossible for maps; compare openedAt+roastDate as a composite key.
	ao, _ := asInt64(a["openedAt"])
	bo, _ := asInt64(b["openedAt"])
	ar, _ := a["roastDate"].(string)
	br, _ := b["roastDate"].(string)
	return ao == bo && ar == br
}

// parseDateMS ports `new Date(str).getTime()` for the date shapes a bean/
// bag roastDate holds: "YYYY-MM-DD" or a full ISO timestamp. ok=false
// mirrors JS's NaN for anything else.
func parseDateMS(s string) (int64, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// localParts ports registry.js's localParts(unixSeconds): server-local
// calendar/clock parts of a Unix-seconds timestamp.
type dateParts struct {
	year, month, day, hour, minute, weekday int
}

func localParts(unixSeconds int64) dateParts {
	d := time.Unix(unixSeconds, 0)
	return dateParts{
		year:    d.Year(),
		month:   int(d.Month()) - 1, // JS months are 0-based
		day:     d.Day(),
		hour:    d.Hour(),
		minute:  d.Minute(),
		weekday: int(d.Weekday()), // JS: Sunday=0, same as Go
	}
}

// isPalindrome ports registry.js's isPalindrome.
func isPalindrome(n int64) bool {
	s := strconv.FormatInt(n, 10)
	for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
		if s[i] != s[j] {
			return false
		}
	}
	return true
}
