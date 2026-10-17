// Package perfseed builds a throwaway SQLite database filled with a large,
// realistic shot history for the #1616 benchmarks and equivalence tests.
// It is imported only from _test files, so none of it is linked into the
// server binary. It writes every table with raw SQL instead of going
// through the domain repositories, so any domain package's own tests can
// import it without an import cycle.
//
// The dataset is deterministic for a given Options value, with one
// deliberate exception: the most recent shots, the maintenance dates and
// the "today" shots are anchored to the local midnight of the day the seed
// runs, so date-relative outputs (shots today, days since a maintenance
// task, the day-streak badges) come out the same on every day the tests
// run. Everything older sits at fixed absolute dates.
package perfseed

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

// machineIDOffset mirrors shots.MachineIDOffset (not imported, see the
// package doc).
const machineIDOffset = 10_000_000

// Options sizes the dataset.
type Options struct {
	// Shots is the total number of shots across both machines.
	Shots int
	// Samples is the number of datapoints per curve series.
	Samples int
}

// Default is the #1616 benchmark size: 5,000 shots with a ~25 s curve
// sampled at 10 Hz.
var Default = Options{Shots: 5000, Samples: 250}

// Info describes what Seed wrote, for assertions and for picking inputs.
type Info struct {
	// Midnight is the local midnight of the seed day.
	Midnight time.Time
	// ShotIDs lists every shot id, trashed ones included, oldest first.
	ShotIDs []int64
	// LatestAnnotatedID is the newest machine-1 shot with a coffee and
	// grinder annotation — an input with plenty of comparable shots for the
	// comparative grind advice.
	LatestAnnotatedID int64
	// TodayShots is the number of non-trashed shots stamped today.
	TodayShots int
}

// Open creates an empty, fully migrated database in a temp dir.
func Open(tb testing.TB) *sql.DB {
	tb.Helper()
	sqlDB, err := db.Open(filepath.Join(tb.TempDir(), "glp.db"))
	if err != nil {
		tb.Fatalf("perfseed: db.Open: %v", err)
	}
	tb.Cleanup(func() { sqlDB.Close() })
	return sqlDB
}

// OpenSeeded is Open followed by Seed.
func OpenSeeded(tb testing.TB, opts Options) (*sql.DB, Info) {
	tb.Helper()
	sqlDB := Open(tb)
	return sqlDB, Seed(tb, sqlDB, opts)
}

var (
	beanNames    = []string{"Ethiopia Guji", "Kenya Nyeri", "Brazil Cerrado", "Colombia Huila", "Decaf Mexico", "House Blend"}
	grinderNames = []string{"Niche Zero", "Mühle Pro", "DF64", "Retired Grinder"}
	// annotated grinder spellings, deliberately differing in case from the
	// library entries — wear matching is case-insensitive.
	grinderSpellings = []string{"Niche Zero", "niche zero", "MÜHLE PRO", "Mühle Pro", "DF64", "Unknown Grinder"}
	profileNames     = []string{"Adaptive", "Londinium", "Blooming", "Turbo", "Leva!"}
)

// Seed fills sqlDB. It must be an empty database from Open.
func Seed(tb testing.TB, sqlDB *sql.DB, opts Options) Info {
	tb.Helper()
	if opts.Shots <= 0 {
		opts = Default
	}
	if opts.Samples <= 0 {
		opts.Samples = Default.Samples
	}
	now := time.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	rng := rand.New(rand.NewPCG(1616, 1))

	tx, err := sqlDB.Begin()
	if err != nil {
		tb.Fatalf("perfseed: begin: %v", err)
	}
	exec := func(q string, args ...any) {
		if _, err := tx.Exec(q, args...); err != nil {
			tx.Rollback()
			tb.Fatalf("perfseed: %s: %v", q, err)
		}
	}

	exec(`INSERT INTO machines (id, name, type, host, switch_entity, is_default, enabled, created_at)
		VALUES (1, 'Kitchen', 'gaggiuino', '', NULL, 1, 1, 1640995200000),
		       (2, 'Office', 'gaggimate', '', 'switch.office_machine', 0, 1, 1640995200000)`)

	// Curve variants: a handful of distinct blobs keeps seeding fast while
	// still giving the scorer different inputs (and the score cache
	// different fingerprints). Variant 0 is an empty curve — a test shot
	// that scores nil.
	variants := make([]string, 8)
	for v := range variants {
		variants[v] = curveBlob(v, opts.Samples)
	}

	// The last tailDays days carry three shots each at fixed local times;
	// the rest of the history spreads over 2021-01-01 .. 2025-12-31 UTC.
	const tailDays = 40
	tail := min(tailDays*3, opts.Shots)
	head := opts.Shots - tail
	histStart := time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC).Unix()
	histEnd := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC).Unix()

	info := Info{Midnight: midnight}
	native := map[int64]int64{1: 0, 2: 0}
	for i := 0; i < opts.Shots; i++ {
		var ts int64
		if i < head {
			step := (histEnd - histStart) / int64(max(head, 1))
			ts = histStart + int64(i)*step + rng.Int64N(max(step/2, 1))
		} else {
			k := i - head // 0 .. tail-1, oldest first
			day := tailDays - 1 - k/3
			hour := []int{7, 12, 18}[k%3]
			ts = midnight.AddDate(0, 0, -day).Add(time.Duration(hour)*time.Hour + 15*time.Minute).Unix()
		}

		machineID := int64(1)
		if i%10 == 9 {
			machineID = 2
		}
		native[machineID]++
		id := native[machineID]
		if machineID != 1 {
			id = machineID*machineIDOffset + native[machineID]
		}

		profile := profileNames[rng.IntN(len(profileNames))]
		variant := 1 + rng.IntN(len(variants)-1)
		if i%97 == 0 {
			variant = 0
		}
		data := variants[variant]

		var duration any = int64(250 + rng.IntN(120))
		if i%211 == 0 {
			duration = nil
		}

		ann := annotation(rng, i)
		// A few legacy rows carry their annotation inside the data blob and
		// have no annotations row — hydration falls back to it.
		legacy := ann != nil && i%53 == 0
		if legacy {
			var m map[string]any
			_ = json.Unmarshal([]byte(data), &m)
			m["annotation"] = ann
			b, _ := json.Marshal(m)
			data = string(b)
		}

		exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,?)`,
			id, ts, duration, profile, data, machineID)
		if ann != nil && !legacy {
			b, _ := json.Marshal(ann)
			exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, id, string(b))
		}
		trashed := i%50 == 7
		if trashed {
			exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, id, ts*1000+60_000)
		}
		info.ShotIDs = append(info.ShotIDs, id)
		if !trashed && ts >= midnight.Unix() {
			info.TodayShots++
		}
		if !trashed && !legacy && machineID == 1 && ann != nil && ann["coffee"] != nil && ann["grinder"] != nil && variant != 0 {
			info.LatestAnnotatedID = id
		}
	}

	exec(`INSERT INTO library (key, data) VALUES ('main', ?)`, libraryBlob(midnight))

	day := func(d float64) string {
		return midnight.Add(-time.Duration(d * float64(24*time.Hour))).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	maint := []struct {
		machine int64
		key     string
		task    map[string]any
	}{
		{1, "descaling", map[string]any{"lastDate": day(20.5), "threshold_days": 60}},
		{1, "backflush", map[string]any{"lastDate": day(6.5), "threshold_shots": 30}},
		{1, "grouphead", map[string]any{"lastDate": day(90.5), "threshold_shots": 500, "threshold_days": 120}},
		{1, "gaskets", map[string]any{"threshold_days": 365}},
		{1, "waterfilter", map[string]any{"lastDate": day(30.5), "threshold_shots": 200}},
		{1, "grinder_101", map[string]any{"lastDate": day(400.5), "threshold_g": 5000}},
		{1, "grinder_102", map[string]any{"lastDate": "2024-03-01", "threshold_shots": 1000}},
		{2, "descaling", map[string]any{"lastDate": day(45.5), "threshold_days": 60}},
		{2, "backflush", map[string]any{"lastDate": day(3.5), "threshold_shots": 30}},
	}
	for _, m := range maint {
		b, _ := json.Marshal(m.task)
		exec(`INSERT INTO maintenance (machine_id, key, data) VALUES (?, ?, ?)`, m.machine, m.key, string(b))
	}
	for i := 0; i < 24; i++ {
		ts := midnight.AddDate(0, 0, -15*(i+1)).Unix()
		task := []string{"descaling", "backflush", "waterfilter"}[i%3]
		exec(`INSERT INTO maintenance_log (ts, date, task, machine, shot_count, notes, machine_id) VALUES (?,?,?,?,?,?,?)`,
			ts, time.Unix(ts, 0).UTC().Format("2006-01-02"), task, "Kitchen", 100+i, "", 1+int64(i%2))
	}

	if err := tx.Commit(); err != nil {
		tb.Fatalf("perfseed: commit: %v", err)
	}
	return info
}

// annotation returns shot i's annotation, or nil for an unannotated shot.
func annotation(rng *rand.Rand, i int) map[string]any {
	if i%7 == 3 {
		return nil
	}
	b := rng.IntN(len(beanNames))
	ann := map[string]any{
		"coffee":       beanNames[b],
		"grinder":      grinderSpellings[rng.IntN(len(grinderSpellings))],
		"grindSetting": fmt.Sprintf("%d", 8+rng.IntN(10)),
		"rating":       1 + rng.IntN(5),
		"tds":          8.5 + float64(rng.IntN(30))/10,
	}
	if i%5 != 0 {
		ann["beanId"] = 1001 + b
	}
	switch i % 6 {
	case 0:
		ann["dose"] = 18.0
	case 1:
		ann["dose"] = "18.5"
	case 2:
		ann["dose"] = 17.5 + float64(rng.IntN(20))/10
	case 3:
		ann["dose"] = 20.25
	case 4:
		// no dose
	case 5:
		ann["dose"] = 19
	}
	if i%4 == 0 {
		ann["grindSetting"] = fmt.Sprintf("%d.5", 8+rng.IntN(10))
	}
	if i%11 == 0 {
		delete(ann, "grinder")
	}
	if i%13 == 0 {
		delete(ann, "coffee")
		delete(ann, "beanId")
	}
	return ann
}

// curveBlob renders one shot data blob (the payload hydration spreads over
// the fixed columns) with a ×10-scaled Gaggiuino-style curve.
func curveBlob(variant, samples int) string {
	if variant == 0 {
		b, _ := json.Marshal(map[string]any{"datapoints": map[string]any{}, "version": "1.5.0"})
		return string(b)
	}
	series := func(fn func(i int) int) []int {
		out := make([]int, samples)
		for i := range out {
			out[i] = fn(i)
		}
		return out
	}
	peak := 80 + variant*3
	temp := 920 + variant*2
	dp := map[string]any{
		"timeInShot": series(func(i int) int { return i }),
		"pressure": series(func(i int) int {
			if i < 40 {
				return i * 2
			}
			return peak - (i%9)/2 - i/40
		}),
		"pumpFlow":   series(func(i int) int { return 15 + (i*variant)%12 }),
		"weightFlow": series(func(i int) int { return (i * 3 / (variant + 1)) % 25 }),
		"shotWeight": series(func(i int) int {
			if i < 50 {
				return 0
			}
			return (i - 50) * (variant + 8) / 5
		}),
		"temperature": series(func(i int) int {
			if i == 17 && variant == 3 {
				return 0 // a thermocouple dropout
			}
			return temp + (i % 5) - 2
		}),
		"waterPumped":       series(func(i int) int { return i * 2 }),
		"targetPressure":    series(func(i int) int { return peak }),
		"targetPumpFlow":    series(func(i int) int { return 20 }),
		"targetTemperature": series(func(i int) int { return temp }),
	}
	b, _ := json.Marshal(map[string]any{"datapoints": dp, "version": "1.5.0", "profileId": variant})
	return string(b)
}

// libraryBlob is the single library row: grinders (one with an unparseable
// burr-reset date, one reset mid-history), beans with bags and brew targets,
// and two recipes.
func libraryBlob(midnight time.Time) string {
	lib := map[string]any{
		"grinders": []any{
			map[string]any{"id": 101, "name": grinderNames[0], "burrType": "conical", "purchaseDate": "2021-01-01"},
			map[string]any{"id": 102, "name": grinderNames[1], "burrType": "flat", "burrsResetAt": "2024-03-01T10:00:00.000Z",
				"zeroPoints": []any{map[string]any{"value": "0", "setAt": "2024-03-01"}}},
			map[string]any{"id": 103, "name": grinderNames[2], "burrsResetAt": "2025-06-15"},
			map[string]any{"id": 104, "name": grinderNames[3], "burrsResetAt": "not a date"},
		},
		"beans":       []any{},
		"recipes":     []any{map[string]any{"id": 2001, "name": "Morning flat white"}, map[string]any{"id": 2002, "name": "Cortado"}},
		"milks":       []any{map[string]any{"id": 3001, "name": "Oat", "stockMl": 1500}},
		"baskets":     []any{map[string]any{"id": 4001, "name": "VST 18g", "doseCapacity": "18"}},
		"puckScreens": []any{},
	}
	beans := []any{}
	for b, name := range beanNames {
		bean := map[string]any{
			"id":        1001 + b,
			"name":      name,
			"roaster":   "Test Roaster",
			"roastDate": "2021-01-01",
			"stock_g":   1000 + 250*b,
			"bags": []any{
				map[string]any{"id": 1, "roastDate": "2023-02-01", "openedAt": time.Date(2023, 2, 10, 8, 0, 0, 0, time.UTC).UnixMilli(), "weight_g": 1000},
				map[string]any{"id": 2, "roastDate": midnight.AddDate(0, 0, -60).Format("2006-01-02"), "openedAt": midnight.AddDate(0, 0, -50).UnixMilli(), "weight_g": 1000},
			},
		}
		if b%2 == 0 {
			bean["brewTempC"] = 92 + b
			bean["brewRatio"] = "1:2"
		}
		if b == 4 {
			bean["enabled"] = false
		}
		beans = append(beans, bean)
	}
	lib["beans"] = beans
	out, _ := json.Marshal(lib)
	return string(out)
}
