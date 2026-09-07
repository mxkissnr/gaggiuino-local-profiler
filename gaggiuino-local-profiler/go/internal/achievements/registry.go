package achievements

import (
	"math"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports lib/achievements/registry.js: the achievements ("stamp
// card") catalogue — the same 48 open + 6 secret badges across 7
// categories. See the Node file's header for the registry contract (id/
// card/stamp/check/progress/secret) and why every check() aggregates
// across ALL machines rather than scoping to the default one.

// cardKeys mirrors registry.js's CARD_KEYS.
var cardKeys = []string{"basics", "craft", "beans", "endurance", "care", "house", "secret"}

// badge mirrors one BADGES entry. ProgressTarget == 0 means "no progress
// bar"; Progress == nil likewise. Retired entries stay in the slice
// forever (never delete a row) but are skipped by the evaluator and the
// state view.
type badge struct {
	ID             string
	Card           string
	Stamp          string
	Secret         bool
	Retired        bool
	ProgressTarget int
	Check          func(*Context) bool
	Progress       func(*Context) int
}

// ── Craft-card math thresholds (registry.js's documented sources) ───────
const (
	tempStableToleranceC        = 1.5
	pressurePlateauToleranceBar = 0.3
	pressurePlateauWindowS      = 10.0
	altitudeSHGm                = 1500.0
	patientMinRestDays          = 7.0
	restedWindowMinDays         = 10.0
	restedWindowMaxDays         = 21.0
	priceLowThresholdEUR        = 0.35
)

var processKeywords = map[string][]string{
	"washed":  {"washed", "wet process", "gewaschen", "nassaufbereitet"},
	"natural": {"natural", "dry process", "natur", "trockenaufbereitet"},
	"honey":   {"honey", "honig", "pulped natural", "miel"},
}

var experimentalKeywords = []string{
	"anaerob", "anaerobic", "carbonic maceration", "kohlensäuremazeration",
	"co-ferment", "coferment", "koji", "thermal shock", "thermoshock",
	"extended fermentation", "wine process", "wein-verarbeitet",
	"double fermentation", "lactic fermentation",
}

func badges() []badge {
	return []badge{
		// ── basics ────────────────────────────────────────────────────
		{ID: "first_connect", Card: "basics", Stamp: "link", Check: func(c *Context) bool {
			for _, m := range c.Machines {
				if m.Host != "" {
					return true
				}
			}
			return false
		}},
		{ID: "first_bean", Card: "basics", Stamp: "bean", Check: func(c *Context) bool { return len(c.Beans) > 0 }},
		{ID: "first_shot", Card: "basics", Stamp: "cup", Check: func(c *Context) bool { return len(c.Shots) > 0 }},
		{ID: "first_profile", Card: "basics", Stamp: "slider", Check: func(c *Context) bool {
			return eventIs(c, "profile-saved") && payloadStr(c, "action") == "create"
		}},
		{ID: "first_rating", Card: "basics", Stamp: "star", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				if ann, _ := s["annotation"].(map[string]any); ann != nil {
					if v, present := ann["rating"]; present && v != nil {
						return true
					}
				}
			}
			return false
		}},
		{ID: "first_milk", Card: "basics", Stamp: "jug", Check: func(c *Context) bool { return ordersDoneWithVariant(c) >= 1 }},
		{ID: "shots_10", Card: "basics", Stamp: "10", ProgressTarget: 10,
			Check:    func(c *Context) bool { return len(c.Shots) >= 10 },
			Progress: func(c *Context) int { return len(c.Shots) }},
		{ID: "first_maint", Card: "basics", Stamp: "wrench", Check: func(c *Context) bool { return len(c.MaintenanceLogs) > 0 }},

		// ── craft ─────────────────────────────────────────────────────
		{ID: "score_90", Card: "craft", Stamp: "90", Check: func(c *Context) bool { return anyShotScoreAtLeast(c, 90) }},
		{ID: "score_95", Card: "craft", Stamp: "95", Check: func(c *Context) bool { return anyShotScoreAtLeast(c, 95) }},
		{ID: "ratio_exact", Card: "craft", Stamp: "1:2", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				if r := shotRatio(s); r != nil && math.Abs(*r-2) < 0.005 {
					return true
				}
			}
			return false
		}},
		{ID: "dialed_in", Card: "craft", Stamp: "target", Check: func(c *Context) bool {
			byBean := map[int64][]shots.Shot{}
			var order []int64
			for _, shot := range c.Shots {
				bean := resolveBeanForShot(shot, c.Beans)
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
			for _, id := range order {
				streak := 0
				for _, s := range byBean[id] {
					sc := shotScore(s)
					if sc != nil && *sc > 85 {
						streak++
					} else {
						streak = 0
					}
					if streak >= 3 {
						return true
					}
				}
			}
			return false
		}},
		{ID: "profile_edit", Card: "craft", Stamp: "book", Check: func(c *Context) bool {
			return eventIs(c, "profile-saved") && payloadStr(c, "action") == "update"
		}},
		{ID: "temp_stable", Card: "craft", Stamp: "shield", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				t := datapointsScaled(s, "temperature", 10)
				if len(t) > 5 && stddev(t) <= tempStableToleranceC {
					return true
				}
			}
			return false
		}},
		{ID: "pressure_flat", Card: "craft", Stamp: "bolt", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				times := datapointsScaled(s, "timeInShot", 10)
				pressures := datapointsScaled(s, "pressure", 10)
				if hasPressurePlateau(times, pressures, pressurePlateauWindowS, pressurePlateauToleranceBar) {
					return true
				}
			}
			return false
		}},
		{ID: "blooming", Card: "craft", Stamp: "drop", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				sc := shotScore(s)
				if sc == nil || *sc < 88 {
					continue
				}
				times := datapointsScaled(s, "timeInShot", 10)
				pressures := datapointsScaled(s, "pressure", 10)
				if pre := detectPreinfusionSeconds(times, pressures); pre != nil && *pre > 10 {
					return true
				}
			}
			return false
		}},

		// ── beans ─────────────────────────────────────────────────────
		{ID: "countries_10", Card: "beans", Stamp: "globe", ProgressTarget: 10,
			Check:    func(c *Context) bool { return len(countryCodes(c.Beans)) >= 10 },
			Progress: func(c *Context) int { return min(len(countryCodes(c.Beans)), 10) }},
		{ID: "roasters_10", Card: "beans", Stamp: "roast", ProgressTarget: 10,
			Check:    func(c *Context) bool { return len(roasterNames(c.Beans)) >= 10 },
			Progress: func(c *Context) int { return min(len(roasterNames(c.Beans)), 10) }},
		{ID: "processes_3", Card: "beans", Stamp: "leaf", ProgressTarget: 3,
			Check:    func(c *Context) bool { return len(processesCovered(c.Beans)) >= 3 },
			Progress: func(c *Context) int { return len(processesCovered(c.Beans)) }},
		{ID: "experimental", Card: "beans", Stamp: "bolt", Check: func(c *Context) bool {
			for _, b := range c.Beans {
				if textMatchesAny(strOf(b["process"]), experimentalKeywords) {
					return true
				}
			}
			return false
		}},
		{ID: "patient", Card: "beans", Stamp: "clock", Check: func(c *Context) bool {
			for _, age := range bagFirstUseAgesDays(c.Shots, c.Beans) {
				if age >= patientMinRestDays {
					return true
				}
			}
			return false
		}},
		{ID: "rested", Card: "beans", Stamp: "moon", Check: func(c *Context) bool {
			for _, age := range bagFirstUseAgesDays(c.Shots, c.Beans) {
				if age >= restedWindowMinDays && age <= restedWindowMaxDays {
					return true
				}
			}
			return false
		}},
		{ID: "altitude", Card: "beans", Stamp: "map", Check: func(c *Context) bool {
			for _, b := range c.Beans {
				if v, ok := asFloat64(b["altitude_m"]); ok && v > altitudeSHGm {
					return true
				}
			}
			return false
		}},
		{ID: "bean_empty", Card: "beans", Stamp: "cup", Check: func(c *Context) bool {
			for _, b := range c.Beans {
				id, ok := beanID(b)
				if !ok {
					continue
				}
				rem, present := c.BeanRemaining[id]
				if present && rem != nil && *rem <= 0 {
					return true
				}
			}
			return false
		}},

		// ── endurance ─────────────────────────────────────────────────
		{ID: "shots_100", Card: "endurance", Stamp: "100", ProgressTarget: 100,
			Check:    func(c *Context) bool { return len(c.Shots) >= 100 },
			Progress: func(c *Context) int { return len(c.Shots) }},
		{ID: "shots_500", Card: "endurance", Stamp: "500", ProgressTarget: 500,
			Check:    func(c *Context) bool { return len(c.Shots) >= 500 },
			Progress: func(c *Context) int { return len(c.Shots) }},
		{ID: "shots_1000", Card: "endurance", Stamp: "1000", ProgressTarget: 1000,
			Check:    func(c *Context) bool { return len(c.Shots) >= 1000 },
			Progress: func(c *Context) int { return len(c.Shots) }},
		{ID: "streak_7", Card: "endurance", Stamp: "flame", ProgressTarget: 7,
			Check:    func(c *Context) bool { return currentDayStreak(shotDaySet(c.Shots), c.Now) >= 7 },
			Progress: func(c *Context) int { return min(currentDayStreak(shotDaySet(c.Shots), c.Now), 7) }},
		{ID: "streak_30", Card: "endurance", Stamp: "30d", ProgressTarget: 30,
			Check:    func(c *Context) bool { return currentDayStreak(shotDaySet(c.Shots), c.Now) >= 30 },
			Progress: func(c *Context) int { return min(currentDayStreak(shotDaySet(c.Shots), c.Now), 30) }},
		{ID: "marathon", Card: "endurance", Stamp: "5x", Check: func(c *Context) bool {
			perDay := map[string]int{}
			for _, s := range c.Shots {
				ts, ok := asInt64(s["timestamp"])
				if !ok {
					continue
				}
				key := time.Unix(ts, 0).Format("Mon Jan 02 2006")
				perDay[key]++
			}
			for _, n := range perDay {
				if n >= 5 {
					return true
				}
			}
			return false
		}},
		{ID: "night", Card: "endurance", Stamp: "23", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				if ts, ok := asInt64(s["timestamp"]); ok && localParts(ts).hour >= 23 {
					return true
				}
			}
			return false
		}},
		{ID: "early", Card: "endurance", Stamp: "sun", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				if ts, ok := asInt64(s["timestamp"]); ok && localParts(ts).hour < 6 {
					return true
				}
			}
			return false
		}},

		// ── care ──────────────────────────────────────────────────────
		{ID: "maint_30", Card: "care", Stamp: "30d", ProgressTarget: 30,
			Check:    func(c *Context) bool { return maintenanceCleanStreakDays(c) >= 30 },
			Progress: func(c *Context) int { return min(maintenanceCleanStreakDays(c), 30) }},
		{ID: "maint_all", Card: "care", Stamp: "wrench", ProgressTarget: 5,
			Check:    func(c *Context) bool { return len(maintenanceTasksDone(c)) >= len(c.StaticMaintenanceTasks) },
			Progress: func(c *Context) int { return len(maintenanceTasksDone(c)) }},
		{ID: "backflush_10", Card: "care", Stamp: "drop", ProgressTarget: 10,
			Check:    func(c *Context) bool { return countMaintLogs(c, "backflush") >= 10 },
			Progress: func(c *Context) int { return min(countMaintLogs(c, "backflush"), 10) }},
		{ID: "descale", Card: "care", Stamp: "leaf", Check: func(c *Context) bool { return countMaintLogs(c, "descaling") >= 1 }},
		{ID: "backup", Card: "care", Stamp: "shield", Check: func(c *Context) bool { return eventIs(c, "backup-exported") }},
		{ID: "two_machines", Card: "care", Stamp: "2", Check: func(c *Context) bool { return len(c.Machines) >= 2 }},
		{ID: "gaggimate", Card: "care", Stamp: "gear", Check: func(c *Context) bool {
			for _, m := range c.Machines {
				if m.Type == "gaggimate" {
					return true
				}
			}
			return false
		}},
		{ID: "up_to_date", Card: "care", Stamp: "bolt", Check: func(c *Context) bool {
			return c.Version.Latest != nil && *c.Version.Latest != "" && !c.Version.UpdateAvailable
		}},

		// ── house ─────────────────────────────────────────────────────
		{ID: "orders_10", Card: "house", Stamp: "10", ProgressTarget: 10,
			Check:    func(c *Context) bool { return ordersDone(c) >= 10 },
			Progress: func(c *Context) int { return min(ordersDone(c), 10) }},
		{ID: "orders_50", Card: "house", Stamp: "jug", ProgressTarget: 50,
			Check:    func(c *Context) bool { return ordersDoneWithVariant(c) >= 50 },
			Progress: func(c *Context) int { return min(ordersDoneWithVariant(c), 50) }},
		{ID: "menu_custom", Card: "house", Stamp: "book", Check: func(c *Context) bool {
			for _, item := range c.Menu {
				if id, ok := item["id"].(string); ok && strings.HasPrefix(id, "m_") {
					return true
				}
			}
			return false
		}},
		{ID: "guest", Card: "house", Stamp: "star", Check: func(c *Context) bool {
			seen := map[string]bool{}
			for _, o := range c.Orders {
				if strOf(o["status"]) != "done" {
					continue
				}
				if u := strOf(o["haUserId"]); u != "" {
					seen[u] = true
				}
			}
			return len(seen) >= 2
		}},
		{ID: "price_low", Card: "house", Stamp: "scale", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				bean := resolveBeanForShot(s, c.Beans)
				if bean == nil {
					continue
				}
				ann, _ := s["annotation"].(map[string]any)
				dose, doseOK := asFloat64(ann["dose"])
				price, priceOK := asFloat64(bean["price_eur"])
				weight, weightOK := asFloat64(bean["weight"])
				if !doseOK || !priceOK || !weightOK || !(price > 0) || !(weight > 0) || !(dose > 0) {
					continue
				}
				if (price/weight)*dose < priceLowThresholdEUR {
					return true
				}
			}
			return false
		}},
		{ID: "restock", Card: "house", Stamp: "bean", Check: func(c *Context) bool {
			return eventIs(c, "bean-changed") && payloadStr(c, "reason") == "restock" && payloadTruthy(c, "wasEmpty")
		}},
		{ID: "flavor_10", Card: "house", Stamp: "target", ProgressTarget: 10,
			Check:    func(c *Context) bool { return len(flavoredShots(c)) >= 10 },
			Progress: func(c *Context) int { return min(len(flavoredShots(c)), 10) }},
		{ID: "share", Card: "house", Stamp: "map", Check: func(c *Context) bool {
			for _, s := range c.Shots {
				if img, ok := s["image"].(string); ok && img != "" {
					return true
				}
			}
			return false
		}},

		// ── secret ────────────────────────────────────────────────────
		{ID: "secret_leap_day", Card: "secret", Secret: true, Check: func(c *Context) bool {
			return anyShotLocalParts(c, func(p dateParts) bool { return p.month == 1 && p.day == 29 })
		}},
		{ID: "secret_friday_13", Card: "secret", Secret: true, Check: func(c *Context) bool {
			return anyShotLocalParts(c, func(p dateParts) bool { return p.weekday == 5 && p.day == 13 })
		}},
		{ID: "secret_witching_hour", Card: "secret", Secret: true, Check: func(c *Context) bool {
			return anyShotLocalParts(c, func(p dateParts) bool { return p.hour == 3 && p.minute == 33 })
		}},
		{ID: "secret_new_year", Card: "secret", Secret: true, Check: func(c *Context) bool {
			return anyShotLocalParts(c, func(p dateParts) bool {
				return p.month == 0 && p.day == 1 && p.hour == 0 && p.minute == 0
			})
		}},
		{ID: "secret_palindrome_id", Card: "secret", Secret: true, Check: func(c *Context) bool {
			for _, s := range c.Shots {
				n, ok := asInt64(s["nativeId"])
				if !ok {
					n, ok = asInt64(s["id"])
				}
				if ok && n >= 100 && isPalindrome(n) {
					return true
				}
			}
			return false
		}},
		{ID: "secret_golden_shot", Card: "secret", Secret: true, Check: func(c *Context) bool {
			for _, s := range c.Shots {
				if r := shotRatio(s); r != nil && math.Abs(*r-1.618) < 0.005 {
					return true
				}
			}
			return false
		}},
	}
}

// ── shared aggregates (registry.js's `_countryCodes` et al.) ───────────

func countryCodes(beans []library.Entity) map[string]bool {
	set := map[string]bool{}
	for _, b := range beans {
		var list []any
		if origins, _ := b["origins"].([]any); len(origins) > 0 {
			list = origins
		} else if code := strOf(b["origin"]); code != "" {
			list = []any{map[string]any{"code": code}}
		}
		for _, o := range list {
			if om, _ := o.(map[string]any); om != nil {
				if code := strOf(om["code"]); code != "" {
					set[code] = true
				}
			}
		}
	}
	return set
}

func roasterNames(beans []library.Entity) map[string]bool {
	set := map[string]bool{}
	for _, b := range beans {
		if r := strings.TrimSpace(strOf(b["roaster"])); r != "" {
			set[strings.ToLower(r)] = true
		}
	}
	return set
}

func processesCovered(beans []library.Entity) map[string]bool {
	set := map[string]bool{}
	for _, b := range beans {
		for key, keywords := range processKeywords {
			if textMatchesAny(strOf(b["process"]), keywords) {
				set[key] = true
			}
		}
	}
	return set
}

func maintenanceTasksDone(c *Context) map[string]bool {
	set := map[string]bool{}
	for _, l := range c.MaintenanceLogs {
		if c.StaticMaintenanceTasks[l.Task] {
			set[l.Task] = true
		}
	}
	return set
}

func countMaintLogs(c *Context, task string) int {
	n := 0
	for _, l := range c.MaintenanceLogs {
		if l.Task == task {
			n++
		}
	}
	return n
}

func shotDaySet(shotList []shots.Shot) map[string]bool {
	set := map[string]bool{}
	for _, s := range shotList {
		if ts, ok := asInt64(s["timestamp"]); ok {
			set[time.UnixMilli(ts*1000).UTC().Format("2006-01-02")] = true
		}
	}
	return set
}

func flavoredShots(c *Context) []shots.Shot {
	var out []shots.Shot
	for _, s := range c.Shots {
		bean := resolveBeanForShot(s, c.Beans)
		if bean == nil {
			continue
		}
		if fl, ok := bean["flavors"].([]any); ok && len(fl) > 0 {
			out = append(out, s)
		}
	}
	return out
}

// ── check-helper primitives ───────────────────────────────────────────

func anyShotScoreAtLeast(c *Context, threshold int) bool {
	for _, s := range c.Shots {
		if sc := shotScore(s); sc != nil && *sc >= threshold {
			return true
		}
	}
	return false
}

func anyShotLocalParts(c *Context, pred func(dateParts) bool) bool {
	for _, s := range c.Shots {
		ts, ok := asInt64(s["timestamp"])
		if !ok {
			continue
		}
		if pred(localParts(ts)) {
			return true
		}
	}
	return false
}

func ordersDone(c *Context) int {
	n := 0
	for _, o := range c.Orders {
		if strOf(o["status"]) == "done" {
			n++
		}
	}
	return n
}

func ordersDoneWithVariant(c *Context) int {
	n := 0
	for _, o := range c.Orders {
		if strOf(o["status"]) == "done" && truthy(o["variant"]) {
			n++
		}
	}
	return n
}

func eventIs(c *Context, typ string) bool {
	return c.Event != nil && c.Event.Type == typ
}

func payloadStr(c *Context, key string) string {
	if c.Event == nil || c.Event.Payload == nil {
		return ""
	}
	return strOf(c.Event.Payload[key])
}

func payloadTruthy(c *Context, key string) bool {
	if c.Event == nil || c.Event.Payload == nil {
		return false
	}
	return truthy(c.Event.Payload[key])
}

// strOf ports JS's implicit string coercion for the free-text fields the
// registry reads: a string stays itself, everything else (including nil)
// is "".
func strOf(v any) string {
	s, _ := v.(string)
	return s
}

// truthy ports a JS truthiness test for the union of shapes an order/menu/
// payload field can hold (string, bool, number, nil).
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0
	case int64:
		return t != 0
	default:
		return true
	}
}

// isRetired ports registry.js's isRetired.
func isRetired(b badge) bool { return b.Retired }
