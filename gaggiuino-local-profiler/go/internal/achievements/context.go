package achievements

import (
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports lib/achievements/context.js: the single read snapshot
// every badge check() runs against, built once per evaluation pass so
// evaluating 54 badges costs one pass over each table, not 54.
//
// Per-install, not per-machine (see registry.go's header) — every
// collection here is gathered across ALL machines.

// VersionCache mirrors the fields of versionCheck.getCached() the
// up_to_date badge reads (`ctx.version.latest`, `ctx.version.updateAvailable
// === false`). Latest is nil when no /api/version request has filled the
// cache yet — the badge treats that as "nothing known", never "up to
// date", exactly like Node's `!!ctx.version.latest` guard. UpdateAvailable
// is a plain bool (Node's getCached() also always returns a concrete
// false, never null).
type VersionCache struct {
	Latest          *string
	UpdateAvailable bool
}

// Event mirrors the `{ type, payload }` object AchievementService.evaluateAll
// passes through to buildContext — the live-moment badges (first_profile,
// profile_edit, backup, restock) key off it.
type Event struct {
	Type    string
	Payload map[string]any
}

// Deps are the cross-domain repositories buildContext reads. VersionFn
// returns the last-known GitHub-release check result without triggering a
// fetch (Node's versionCheck.getCached()); cmd/server wires it to
// internal/system's cached checker.
type Deps struct {
	Shots       *shots.Repository
	Library     *library.Repository
	Orders      *orders.Repository
	Maintenance *maintenance.Repository
	Registry    *machines.Registry
	VersionFn   func() VersionCache
}

// Context is the ported ctx object. Field names track context.js.
type Context struct {
	Now   int64 // Date.now() — milliseconds
	Event *Event

	Shots         []shots.Shot     // demo-filtered, each with ["score"] injected
	Beans         []library.Entity // demo-filtered
	BeanRemaining map[int64]*int64 // bean id -> remaining grams (nil = unknown)
	Menu          []orders.MenuItem
	Orders        []orders.Order
	Machines      []machines.Machine

	MaintenanceLogs            []maintenance.LogEntry
	MaintenanceConfigByMachine map[int64]map[string]maintenance.Task
	StaticMaintenanceTasks     map[string]bool

	Version VersionCache
}

// staticMaintenanceTasks mirrors lib/constants.js's STATIC_MAINTENANCE_TASKS.
var staticMaintenanceTasks = map[string]bool{
	"descaling": true, "backflush": true, "grouphead": true,
	"gaskets": true, "waterfilter": true,
}

// buildContext ports context.js's buildContext(event).
func buildContext(deps Deps, event *Event) (*Context, error) {
	machineList, err := deps.Registry.ListMachines()
	if err != nil {
		return nil, err
	}

	rawShots, err := deps.Shots.FindAllExcludingTrash()
	if err != nil {
		return nil, err
	}
	lib, err := deps.Library.GetLibrary()
	if err != nil {
		return nil, err
	}
	beans := make([]library.Entity, 0, len(lib.Beans))
	for _, b := range lib.Beans {
		if id, ok := beanID(b); ok && isDemoLibraryID(id) {
			continue
		}
		beans = append(beans, b)
	}

	scoredShots := make([]shots.Shot, 0, len(rawShots))
	for _, s := range rawShots {
		if isDemoShot(s) {
			continue
		}
		clone := make(shots.Shot, len(s)+1)
		for k, v := range s {
			clone[k] = v
		}
		clone["score"] = scoreForShot(s, beans)
		scoredShots = append(scoredShots, clone)
	}

	doseRows, err := deps.Shots.GetAnnotatedDoses()
	if err != nil {
		return nil, err
	}
	beanRemaining := map[int64]*int64{}
	for _, b := range beans {
		id, ok := beanID(b)
		if !ok {
			continue
		}
		if rem, present := library.ComputeBeanRemaining(b, doseRows, beans); present {
			v := rem
			beanRemaining[id] = &v
		} else {
			beanRemaining[id] = nil
		}
	}

	orderList, err := deps.Orders.FindAll()
	if err != nil {
		return nil, err
	}
	menu, err := deps.Orders.GetMenu()
	if err != nil {
		return nil, err
	}

	maintLogs, err := deps.Maintenance.GetMaintenanceLog(0)
	if err != nil {
		return nil, err
	}
	configByMachine := map[int64]map[string]maintenance.Task{}
	for _, m := range machineList {
		conf, err := deps.Maintenance.GetMaintenance(m.ID)
		if err != nil {
			return nil, err
		}
		configByMachine[m.ID] = conf
	}

	version := VersionCache{}
	if deps.VersionFn != nil {
		version = deps.VersionFn()
	}

	return &Context{
		Now:                        time.Now().UnixMilli(),
		Event:                      event,
		Shots:                      scoredShots,
		Beans:                      beans,
		BeanRemaining:              beanRemaining,
		Menu:                       menu,
		Orders:                     orderList,
		Machines:                   machineList,
		MaintenanceLogs:            maintLogs,
		MaintenanceConfigByMachine: configByMachine,
		StaticMaintenanceTasks:     staticMaintenanceTasks,
		Version:                    version,
	}, nil
}

// scoreForShot ports context.js's `score: shotService.computeScoreDetail(s)
// .score` — resolve the shot's library bean (beanId-first, coffee-name
// fallback — the same resolution helpers.js's resolveBeanForShot does, and
// what LibraryService.resolveBeanForAnnotation does in Node) and score
// against its own brewTempC/brewRatio target when it has one. Returns *int
// (nil for JS's null — not enough datapoints to score).
func scoreForShot(shot shots.Shot, beans []library.Entity) *int {
	var bean *shots.Bean
	if resolved := resolveBeanForShot(shot, beans); resolved != nil {
		b := shots.Bean{}
		if t, ok := asFloat64(resolved["brewTempC"]); ok && t > 0 {
			b.BrewTempC = &t
		}
		if r, _ := resolved["brewRatio"].(string); r != "" {
			b.BrewRatio = r
		}
		bean = &b
	}
	return shots.CalcShotScoreDetail(shot, bean).Score
}

// shotScore reads the injected ["score"] as *int.
func shotScore(shot shots.Shot) *int {
	v, _ := shot["score"].(*int)
	return v
}
