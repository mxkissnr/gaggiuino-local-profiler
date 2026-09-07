package system

import (
	"database/sql"
	"encoding/json"
	"math"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports lib/services/DemoService.js + lib/demo-seed.js: POST
// /api/demo/seed and POST /api/demo/end (#274) — a static sample dataset
// so a first-run user with no machine reachable yet can still see the app
// populated. Both dependencies this needed (shots, library) are ported
// domains as of Phase 1d/1c, so — per this phase's brief — demo mode is
// fully in scope, not deferred.

const demoKVKey = "demo_seed"

// demoIDBase mirrors DEMO_ID_BASE: a high range a real machine's own
// sequential shot ids will never reach, so demo rows are trivially
// distinguishable and never collide with real data.
const demoIDBase = 900_000_000

// DemoService ports DemoService.js as a struct around this package's own
// *sql.DB handle (for the demo_seed kv record) plus the shots/library
// repositories it seeds into — same db handle cmd/server already opens
// once, passed in rather than reopened.
type DemoService struct {
	db      *sql.DB
	shots   *shots.Repository
	library *library.Repository
}

func NewDemoService(db *sql.DB, shotsRepo *shots.Repository, libRepo *library.Repository) *DemoService {
	return &DemoService{db: db, shots: shotsRepo, library: libRepo}
}

type demoSeedRecord struct {
	Active    bool    `json:"active"`
	ShotIDs   []int64 `json:"shotIds"`
	BeanIDs   []int64 `json:"beanIds"`
	RecipeIDs []int64 `json:"recipeIds"`
	SeededAt  int64   `json:"seededAt"`
}

func (d *DemoService) loadSeedRecord() *demoSeedRecord {
	var value string
	if err := d.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, demoKVKey).Scan(&value); err != nil {
		return nil
	}
	var rec demoSeedRecord
	if err := json.Unmarshal([]byte(value), &rec); err != nil {
		return nil
	}
	return &rec
}

func (d *DemoService) saveSeedRecord(rec demoSeedRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, demoKVKey, string(b))
	return err
}

func (d *DemoService) clearSeedRecord() error {
	_, err := d.db.Exec(`DELETE FROM kv WHERE key = ?`, demoKVKey)
	return err
}

// IsDemoActive ports isDemoActive().
func (d *DemoService) IsDemoActive() bool {
	rec := d.loadSeedRecord()
	return rec != nil && rec.Active
}

// IsEmpty ports isEmpty(): refuses to seed on top of real data.
func (d *DemoService) IsEmpty() (bool, error) {
	all, err := d.shots.FindAll()
	if err != nil {
		return false, err
	}
	if len(all) > 0 {
		return false, nil
	}
	lib, err := d.library.GetLibrary()
	if err != nil {
		return false, err
	}
	return len(lib.Beans) == 0 && len(lib.Recipes) == 0, nil
}

// SeedDemoData ports seedDemoData().
func (d *DemoService) SeedDemoData() error {
	shotsDS, beans, recipes := buildDemoDataset(time.Now().UnixMilli())

	for _, s := range shotsDS {
		if err := d.shots.Upsert(s); err != nil {
			return err
		}
	}

	lib, err := d.library.GetLibrary()
	if err != nil {
		return err
	}
	lib.Beans = append(lib.Beans, beans...)
	lib.Recipes = append(lib.Recipes, recipes...)
	if err := d.library.SaveLibrary(lib); err != nil {
		return err
	}

	rec := demoSeedRecord{Active: true, SeededAt: time.Now().UnixMilli()}
	for _, s := range shotsDS {
		rec.ShotIDs = append(rec.ShotIDs, s["id"].(int64))
	}
	for _, b := range beans {
		rec.BeanIDs = append(rec.BeanIDs, b["id"].(int64))
	}
	for _, r := range recipes {
		rec.RecipeIDs = append(rec.RecipeIDs, r["id"].(int64))
	}
	return d.saveSeedRecord(rec)
}

// EndDemo ports endDemo(): deletes exactly the rows recorded at seed time,
// nothing else.
func (d *DemoService) EndDemo() error {
	rec := d.loadSeedRecord()
	if rec == nil {
		return nil
	}
	for _, id := range rec.ShotIDs {
		if err := d.shots.DeleteByID(id); err != nil {
			return err
		}
	}

	lib, err := d.library.GetLibrary()
	if err != nil {
		return err
	}
	beanIDs := toIDSet(rec.BeanIDs)
	recipeIDs := toIDSet(rec.RecipeIDs)
	lib.Beans = filterOutIDs(lib.Beans, beanIDs)
	lib.Recipes = filterOutIDs(lib.Recipes, recipeIDs)
	if err := d.library.SaveLibrary(lib); err != nil {
		return err
	}

	return d.clearSeedRecord()
}

func toIDSet(ids []int64) map[int64]bool {
	set := make(map[int64]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

func filterOutIDs(entities []library.Entity, ids map[int64]bool) []library.Entity {
	out := make([]library.Entity, 0, len(entities))
	for _, e := range entities {
		id, ok := entityID(e)
		if ok && ids[id] {
			continue
		}
		out = append(out, e)
	}
	return out
}

func entityID(e library.Entity) (int64, bool) {
	switch v := e["id"].(type) {
	case int64:
		return v, true
	case float64:
		return int64(v), true
	}
	return 0, false
}

// ── lib/demo-seed.js's static dataset ───────────────────────────────────

type demoShotDef struct {
	daysAgo int
	seconds float64
	dose    float64
	yieldG  float64
	temp    float64
	peak    float64
	coffee  string
	profile string
	rating  int
	tds     float64
	grind   string
}

var demoBeanIDByName = map[string]int64{
	"GLP Demo — Ethiopia Yirgacheffe":  demoIDBase + 101,
	"GLP Demo — Brasil/Ethiopia Blend": demoIDBase + 102,
	"GLP Demo — Colombia Decaf":        demoIDBase + 103,
}

var demoShotDefs = []demoShotDef{
	{daysAgo: 21, seconds: 28, dose: 18, yieldG: 36, temp: 93, peak: 9.2, coffee: "GLP Demo — Ethiopia Yirgacheffe", profile: "Demo Profile 1", rating: 5, tds: 9.4, grind: "18 clicks"},
	{daysAgo: 20, seconds: 30, dose: 18, yieldG: 38, temp: 93, peak: 9.0, coffee: "GLP Demo — Ethiopia Yirgacheffe", profile: "Demo Profile 1", rating: 4, tds: 9.1, grind: "18 clicks"},
	{daysAgo: 18, seconds: 27, dose: 18.2, yieldG: 34, temp: 92, peak: 9.4, coffee: "GLP Demo — Ethiopia Yirgacheffe", profile: "Demo Profile 1", rating: 4, tds: 9.6, grind: "17 clicks"},
	{daysAgo: 15, seconds: 32, dose: 18, yieldG: 44, temp: 94, peak: 8.7, coffee: "GLP Demo — Brasil/Ethiopia Blend", profile: "Demo Profile 2", rating: 5, tds: 8.8, grind: "20 clicks"},
	{daysAgo: 13, seconds: 31, dose: 18.5, yieldG: 42, temp: 94, peak: 8.9, coffee: "GLP Demo — Brasil/Ethiopia Blend", profile: "Demo Profile 2", rating: 3, tds: 8.5, grind: "20 clicks"},
	{daysAgo: 10, seconds: 29, dose: 18, yieldG: 37, temp: 93, peak: 9.1, coffee: "GLP Demo — Brasil/Ethiopia Blend", profile: "Demo Profile 2", rating: 4, tds: 9.0, grind: "19 clicks"},
	{daysAgo: 8, seconds: 26, dose: 17.8, yieldG: 33, temp: 92, peak: 9.5, coffee: "GLP Demo — Colombia Decaf", profile: "Demo Profile 3", rating: 4, tds: 9.7, grind: "16 clicks"},
	{daysAgo: 6, seconds: 33, dose: 18, yieldG: 45, temp: 94, peak: 8.6, coffee: "GLP Demo — Colombia Decaf", profile: "Demo Profile 3", rating: 3, tds: 8.3, grind: "21 clicks"},
	{daysAgo: 4, seconds: 28, dose: 18.2, yieldG: 36, temp: 93, peak: 9.2, coffee: "GLP Demo — Ethiopia Yirgacheffe", profile: "Demo Profile 1", rating: 5, tds: 9.5, grind: "18 clicks"},
	{daysAgo: 2, seconds: 30, dose: 18, yieldG: 40, temp: 93, peak: 9.0, coffee: "GLP Demo — Brasil/Ethiopia Blend", profile: "Demo Profile 2", rating: 4, tds: 9.0, grind: "19 clicks"},
	{daysAgo: 1, seconds: 29, dose: 18, yieldG: 38, temp: 93, peak: 9.1, coffee: "GLP Demo — Ethiopia Yirgacheffe", profile: "Demo Profile 1", rating: 5, tds: 9.3, grind: "18 clicks"},
	{daysAgo: 0, seconds: 31, dose: 18.3, yieldG: 41, temp: 94, peak: 8.9, coffee: "GLP Demo — Colombia Decaf", profile: "Demo Profile 3", rating: 4, tds: 8.9, grind: "20 clicks"},
}

// buildCurve ports buildCurve({seconds, peakPressure, targetTemp, yieldG}):
// a plausible espresso-shot datapoints object, 0.1s steps, values in tenths
// of their unit — matches lib/poll.js's liveAccum shape (see poll.go).
func buildCurve(seconds, peakPressure, targetTemp, yieldG float64) liveDatapoints {
	steps := int(math.Round(seconds * 10))
	dp := liveDatapoints{}
	var prevWeight float64
	for i := 0; i <= steps; i++ {
		t := float64(i) / 10
		rampUp := math.Min(1, t/4)
		rampDown := 1.0
		if t > seconds-5 {
			rampDown = math.Max(0, (seconds-t)/5)
		}
		pr := peakPressure * rampUp * rampDown
		temp := targetTemp - 0.4 + math.Sin(t/3)*0.3
		progress := math.Min(1, t/seconds)
		weight := math.Round(yieldG*math.Pow(progress, 1.3)*10) / 10
		flow := weight - prevWeight
		prevWeight = weight

		dp.TimeInShot = append(dp.TimeInShot, round10(t))
		dp.Pressure = append(dp.Pressure, round10(pr))
		dp.Temperature = append(dp.Temperature, round10(temp))
		dp.ShotWeight = append(dp.ShotWeight, round10(weight))
		dp.WeightFlow = append(dp.WeightFlow, round10(flow))
		dp.PumpFlow = append(dp.PumpFlow, round10(math.Max(0, pr*0.9)))
		dp.TargetTemperature = append(dp.TargetTemperature, round10(targetTemp))
	}
	return dp
}

// buildDemoDataset ports buildDemoDataset(now): fresh, deterministic-per-call
// timestamps (relative to nowMs) so the shot list always looks recent when
// demo mode is (re-)activated.
func buildDemoDataset(nowMs int64) ([]shots.Shot, []library.Entity, []library.Entity) {
	nowSec := nowMs / 1000
	const day = 86400

	out := make([]shots.Shot, 0, len(demoShotDefs))
	for i, def := range demoShotDefs {
		id := int64(demoIDBase + i + 1)
		dp := buildCurve(def.seconds, def.peak, def.temp, def.yieldG)
		beanID, hasBean := demoBeanIDByName[def.coffee]
		annotation := map[string]any{
			"coffee":       def.coffee,
			"grindSetting": def.grind,
			"dose":         def.dose,
			"tds":          def.tds,
			"rating":       def.rating,
			"notes":        "Demo shot — generated by GLP demo mode.",
		}
		if hasBean {
			annotation["beanId"] = beanID
		} else {
			annotation["beanId"] = nil
		}
		out = append(out, shots.Shot{
			"id":          id,
			"timestamp":   nowSec - int64(def.daysAgo)*day - int64(len(demoShotDefs)-i)*3600,
			"duration":    int64(math.Round(def.seconds * 10)),
			"profileName": def.profile,
			"datapoints":  dp,
			"annotation":  annotation,
		})
	}

	roastDate := func(daysAgo int) string {
		return time.UnixMilli(nowMs - int64(daysAgo)*day*1000).UTC().Format("2006-01-02")
	}

	beans := []library.Entity{
		{
			"id": int64(demoIDBase + 101), "name": "GLP Demo — Ethiopia Yirgacheffe",
			"roaster": "GLP Demo Roastery", "roastDate": roastDate(10),
			"notes": "Sample bean seeded by GLP demo mode.", "origin": "ET",
			"origins": []library.Entity{{"code": "ET"}}, "variety": "Heirloom", "process": "Washed",
			"flavors": []string{"Bergamot", "Blueberry", "Black Tea"}, "roastType": "filter",
			"stock_g": float64(250), "decaf": false,
			"bags": []library.Entity{{"id": int64(demoIDBase + 201), "roastDate": roastDate(10), "stock_g": float64(250), "openedAt": nowMs - 20*day*1000}},
		},
		{
			"id": int64(demoIDBase + 102), "name": "GLP Demo — Brasil/Ethiopia Blend",
			"roaster": "GLP Demo Roastery", "roastDate": roastDate(15),
			"notes": "Blend example — demonstrates origins[] with per-country percent.", "origin": "BR",
			"origins": []library.Entity{{"code": "BR", "percent": float64(60)}, {"code": "ET", "percent": float64(40)}},
			"variety": "Bourbon / Heirloom", "process": "Natural",
			"flavors": []string{"Chocolate", "Hazelnut", "Caramel"}, "roastType": "espresso",
			"stock_g": float64(500), "decaf": false,
			"bags": []library.Entity{{"id": int64(demoIDBase + 202), "roastDate": roastDate(15), "stock_g": float64(500), "openedAt": nowMs - 15*day*1000}},
		},
		{
			"id": int64(demoIDBase + 103), "name": "GLP Demo — Colombia Decaf",
			"roaster": "GLP Demo Roastery", "roastDate": roastDate(8),
			"notes": "Decaf sample bean.", "origin": "CO",
			"origins": []library.Entity{{"code": "CO"}}, "variety": "Castillo", "process": "Washed (Sugarcane EA Decaf)",
			"flavors": []string{"Walnut", "Brown Sugar"}, "roastType": "espresso",
			"stock_g": float64(250), "decaf": true,
			"bags": []library.Entity{{"id": int64(demoIDBase + 203), "roastDate": roastDate(8), "stock_g": float64(250), "openedAt": nowMs - 8*day*1000}},
		},
	}

	recipes := []library.Entity{
		{
			"id": int64(demoIDBase + 301), "name": "GLP Demo — Balanced Espresso",
			"brewMethod": "espresso", "drinkType": "espresso", "grindSize": "18 clicks", "sourceUrl": "",
			"steps": []library.Entity{
				{"text": "18g in, 45g out, 30s — 1:2.5 ratio", "duration_s": float64(30)},
				{"text": "Preheat portafilter, tamp evenly", "duration_s": nil},
			},
			"notes": "Demo recipe seeded by GLP demo mode.", "profileName": "Demo Profile 1",
			"beanName": "GLP Demo — Ethiopia Yirgacheffe",
		},
	}

	return out, beans, recipes
}
