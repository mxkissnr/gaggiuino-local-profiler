package achievements

import (
	stdjson "encoding/json"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// The single read snapshot every badge check() runs against, built once
// per evaluation pass so evaluating 63 badges costs one pass over each
// table, not 54.
//
// Per-install, not per-machine (see registry.go's header) — every
// collection here is gathered across ALL machines.

// VersionCache holds the fields the up_to_date badge reads
// (`ctx.version.latest`, `ctx.version.updateAvailable === false`). Latest is
// nil when no /api/version request has filled the cache yet — the badge
// treats that as "nothing known", never "up to date". UpdateAvailable is a
// plain bool (always a concrete false, never null).
type VersionCache struct {
	Latest          *string
	UpdateAvailable bool
}

// Event is the `{ type, payload }` value passed to buildContext — the
// live-moment badges (first_profile, profile_edit, backup, restock) key off
// it.
type Event struct {
	Type    string
	Payload map[string]any
}

// Deps are the cross-domain repositories buildContext reads. VersionFn
// returns the last-known GitHub-release check result without triggering a
// fetch; cmd/server wires it to internal/system's cached checker. RevsFn, when
// set, returns the current data-change revision digest (sse.DataChanges.Revs()
// formatted by cmd/server); maybeEvaluate folds it into the change fingerprint
// so a mutation the aggregate fingerprint cannot see — an equal-length rating
// edit or a photo upload — still re-runs the evaluator.
type Deps struct {
	Shots       *shots.Repository
	Library     *library.Repository
	Orders      *orders.Repository
	Maintenance *maintenance.Repository
	Registry    *machines.Registry
	VersionFn   func() VersionCache
	RevsFn      func() string
}

// Context is the read snapshot built by buildContext.
type Context struct {
	Now   int64 // milliseconds since epoch
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

// staticMaintenanceTasks is the built-in set of maintenance tasks.
var staticMaintenanceTasks = map[string]bool{
	"descaling": true, "backflush": true, "grouphead": true,
	"gaskets": true, "waterfilter": true,
}

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
		// Decode the curve once here instead of once per badge that reads it
		// (#1616: ~10-14 decodes per shot per pass). The score above still
		// runs on the raw bytes, exactly as before.
		if raw, ok := s["datapoints"].(stdjson.RawMessage); ok {
			clone["datapoints"] = newShotSeries(raw)
		}
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

// scoreForShot resolves the shot's library bean (beanId-first, coffee-name
// fallback — library.ScoreBean, the one implementation shared with the
// server-side scorer) and scores against its own brewTempC/brewRatio target
// when it has one. Returns *int (nil when there are not enough datapoints
// to score).
func scoreForShot(shot shots.Shot, beans []library.Entity) *int {
	return shots.CalcShotScoreDetail(shot, library.ScoreBean(shot, beans)).Score
}

// shotScore reads the injected ["score"] as *int.
func shotScore(shot shots.Shot) *int {
	v, _ := shot["score"].(*int)
	return v
}

// shotSeries is a context shot's "datapoints" value: the curve blob
// tokenized once into its top-level series, each decoded into the []float64
// of its numeric samples on first use and kept for every later badge.
// datapointsScaled reads it; the samples are exactly the ones the
// DatapointsMap + asFloat64 path yields for a JSON curve (float64 values,
// nulls dropped — shots.DecodeFloatArray).
type shotSeries struct {
	raw  map[string]stdjson.RawMessage
	vals map[string][]float64
}

func newShotSeries(raw stdjson.RawMessage) *shotSeries {
	return &shotSeries{raw: shots.SplitSeries(raw), vals: map[string][]float64{}}
}

// samples returns key's numeric samples (nil when the series is absent or
// not an array).
func (ss *shotSeries) samples(key string) []float64 {
	if v, ok := ss.vals[key]; ok {
		return v
	}
	var v []float64
	if r, ok := ss.raw[key]; ok {
		v = shots.DecodeFloatArray(r)
	}
	ss.vals[key] = v
	return v
}
