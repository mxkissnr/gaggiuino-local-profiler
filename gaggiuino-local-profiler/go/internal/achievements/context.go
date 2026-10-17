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
// per evaluation pass so evaluating every badge costs one pass over each
// table, not one per badge.
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

	Shots         []shots.Shot     // demo-filtered light shots, see contextShot
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

	// One streamed pass over the history (#1721): the score comes from the
	// score cache (a miss is scored against the shot's library bean, exactly
	// as before, and backfilled), and each shot keeps only the fields the
	// badge rules read plus the few values they derive from its curve — no
	// shot's datapoints outlive its row.
	scoredShots := []shots.Shot{}
	err = deps.Shots.EachScoredExcludingTrash(
		func(s shots.Shot) *shots.Bean { return library.ScoreBean(s, beans) },
		func(s shots.Shot, score *int) error {
			if isDemoShot(s) {
				return nil
			}
			scoredShots = append(scoredShots, contextShot(s, score))
			return nil
		})
	if err != nil {
		return nil, err
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

// contextShotKeys are the hydrated-shot fields the badge rules (and the
// library bean resolution they call) read; contextShot keeps only these.
var contextShotKeys = []string{"id", "timestamp", "machineId", "nativeId", "annotation", "image"}

// contextShot reduces a hydrated shot to the light shot the badge rules run
// against: contextShotKeys, the cached score under ["score"], and the
// values the rules derive from the curve under [curveKey] (#1721).
func contextShot(s shots.Shot, score *int) shots.Shot {
	out := make(shots.Shot, len(contextShotKeys)+2)
	for _, k := range contextShotKeys {
		if v, ok := s[k]; ok {
			out[k] = v
		}
	}
	out["score"] = score
	out[curveKey] = newCurveStats(s)
	return out
}

// shotScore reads the injected ["score"] as *int.
func shotScore(shot shots.Shot) *int {
	v, _ := shot["score"].(*int)
	return v
}

// curveKey holds a context shot's *curveStats.
const curveKey = "achievementsCurve"

// curveStats is everything the badge rules read from a shot's curve,
// computed once while its row is streamed so the curve itself is dropped
// (#1721). Each field is exactly what the rule's helper returns for the
// full shot: finalWeightG, the temp_stable and pressure_flat tests, and
// detectPreinfusionSeconds for blooming.
type curveStats struct {
	finalWeightG       float64
	tempStable         bool
	pressurePlateau    bool
	preinfusionSeconds *float64
}

func newCurveStats(s shots.Shot) *curveStats {
	// Decode the curve once for all four values (#1616): the same samples
	// the DatapointsMap + asFloat64 path yields, see shotSeries.
	full := shots.Shot{"datapoints": s["datapoints"]}
	if raw, ok := s["datapoints"].(stdjson.RawMessage); ok {
		full["datapoints"] = newShotSeries(raw)
	}
	times := datapointsScaled(full, "timeInShot", 10)
	pressures := datapointsScaled(full, "pressure", 10)
	return &curveStats{
		finalWeightG:       finalWeightG(full),
		tempStable:         isTempStable(full),
		pressurePlateau:    hasPressurePlateau(times, pressures, pressurePlateauWindowS, pressurePlateauToleranceBar),
		preinfusionSeconds: detectPreinfusionSeconds(times, pressures),
	}
}

// curveOf returns a context shot's *curveStats, nil for any other shot.
func curveOf(shot shots.Shot) *curveStats {
	cs, _ := shot[curveKey].(*curveStats)
	return cs
}

// shotSeries is a shot's "datapoints" value while newCurveStats runs: the
// curve blob tokenized once into its top-level series, each decoded into the
// []float64 of its numeric samples on first use and kept for the later
// reads. datapointsScaled reads it; the samples are exactly the ones the
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
