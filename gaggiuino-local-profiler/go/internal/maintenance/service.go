package maintenance

import (
	"errors"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports LibraryService.js's computeMaintenanceStats and
// routes/maintenance.js's computeAllMachinesMaintenance.

// ErrUnknownTask is MarkTaskDone's error for a task name that doesn't
// canonicalize (see canonicalTask in model.go) — a static task typo, or a
// grinder_<id> for an id that isn't currently a real grinder.
var ErrUnknownTask = errors.New("unknown maintenance task")

// MarkTaskDone ports routes/maintenance.js's POST /api/maintenance/:task/done
// business logic (handlers.go's taskDone, which is now a thin wrapper around
// this): validate the task, stamp lastDate, persist it, and add a
// maintenance_log entry — then return the freshly recomputed stats for
// machineID. Extracted into this service-layer function, not left as a
// REST-handler-only private method, specifically so internal/web's
// maintenance page (#901 Phase 2e) gets the exact same maintenance_log side
// effect the REST path does instead of silently missing it — the same
// service-layer-extraction fix Phase 2d already applied to
// internal/orders' AcceptOrder/CompleteOrder/DeclineOrder (see that
// package's service.go) after the web queue was found to skip the
// customer HA-notify side effect a REST-handler-only method held.
func MarkTaskDone(repo *Repository, shotsRepo *shots.Repository, libRepo *library.Repository, registry *machines.Registry, rawTask, notes string, machineID int64) (map[string]Stat, error) {
	task, valid := canonicalTask(libRepo, rawTask)
	if !valid {
		return nil, ErrUnknownTask
	}
	maint, err := repo.GetMaintenance(machineID)
	if err != nil {
		return nil, err
	}
	t := maint[task]
	if t == nil {
		t = Task{}
	}
	// new Date().toISOString() — millisecond-precision UTC timestamp.
	t["lastDate"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	maint[task] = t
	if err := repo.SaveMaintenance(maint, machineID); err != nil {
		return nil, err
	}
	if _, err := repo.AddMaintenanceLogEntry(task, notes, machineHostname(registry), shotCountFor(shotsRepo, task, machineID), machineID); err != nil {
		return nil, err
	}
	return ComputeMaintenanceStats(shotsRepo, maint, machineID)
}

// Stat is one task's computed maintenance-due state — Task's fields plus
// daysSince/shotsSince/pct/status, mirroring
// `{ ...task, daysSince, shotsSince, pct, status }`.
type Stat = map[string]any

// ComputeMaintenanceStats ports LibraryService.js's
// computeMaintenanceStats(maint, machineId): per-task days/shots since
// last done, percent-to-threshold, and a due/soon/ok/never status.
// descaling/backflush/grouphead/gaskets scope shot counts to the active
// machine; waterfilter/grinder_* (shared equipment, #338) count shots
// across every machine.
func ComputeMaintenanceStats(shotsRepo *shots.Repository, maint map[string]Task, machineID int64) (map[string]Stat, error) {
	globalShots, err := shotsRepo.FindAllExcludingTrash()
	if err != nil {
		return nil, err
	}
	scopedShots, err := shotsRepo.FindAllExcludingTrashByMachine(machineID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()

	result := make(map[string]Stat, len(maint))
	for key, task := range maint {
		shotList := scopedShots
		if isGlobalMaintenanceTask(key) {
			shotList = globalShots
		}
		var lastTs int64
		if lastDate, _ := task["lastDate"].(string); lastDate != "" {
			if t, err := parseJSDate(lastDate); err == nil {
				lastTs = t
			}
		}
		var daysSince any
		if lastTs != 0 {
			daysSince = jsFloorDivDays(now - lastTs)
		}
		var shotsSince int
		for _, s := range shotList {
			ts, _ := s["timestamp"].(int64)
			if ts*1000 > lastTs {
				shotsSince++
			}
		}

		thresholdShots, hasShots := jsPositiveInt(task["threshold_shots"])
		thresholdDays, hasDays := jsPositiveInt(task["threshold_days"])
		var pct float64
		switch {
		case hasShots && hasDays:
			shotsPct := float64(shotsSince) / float64(thresholdShots)
			var daysPct float64
			if daysSince != nil {
				daysPct = float64(daysSince.(int64)) / float64(thresholdDays)
			}
			pct = shotsPct
			if daysPct > pct {
				pct = daysPct
			}
		case hasShots:
			pct = float64(shotsSince) / float64(thresholdShots)
		case hasDays:
			if daysSince != nil {
				pct = float64(daysSince.(int64)) / float64(thresholdDays)
			}
		}

		status := "never"
		lastDate, hasLastDate := task["lastDate"].(string)
		if hasLastDate && lastDate != "" {
			switch {
			case pct >= 1:
				status = "due"
			case pct >= 0.8:
				status = "soon"
			default:
				status = "ok"
			}
		}
		if pct > 1 {
			pct = 1
		}

		stat := Stat{}
		for k, v := range task {
			stat[k] = v
		}
		stat["daysSince"] = daysSince
		stat["shotsSince"] = shotsSince
		stat["pct"] = pct
		stat["status"] = status
		result[key] = stat
	}
	return result, nil
}

// parseJSDate ports `new Date(str).getTime()` for lastDate's two string
// shapes: a full ISO timestamp (POST .../done writes
// `new Date().toISOString()`) or a plain "YYYY-MM-DD" restore/import value.
func parseJSDate(s string) (int64, error) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), nil
		}
	}
	return 0, errBadDate
}

var errBadDate = errors.New("unparseable date")

// jsFloorDivDays ports `Math.floor(deltaMs / 86400000)`: Go's integer
// division truncates toward zero, which diverges from Math.floor for a
// negative deltaMs (lastTs in the future — clock skew, or a hand-edited/
// restored backup) whenever the division isn't exact, e.g. 1.5 days in the
// future truncates to -1 in Go but must floor to -2 like Node (#901 code
// review).
func jsFloorDivDays(deltaMs int64) int64 {
	const dayMs = 86400000
	q := deltaMs / dayMs
	if deltaMs%dayMs != 0 && deltaMs < 0 {
		q--
	}
	return q
}

// jsPositiveInt ports the `task.threshold_shots`/`task.threshold_days`
// truthiness check (`if (task.threshold_shots)`): present, non-nil, and
// non-zero.
func jsPositiveInt(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, t != 0
	case float64:
		return int64(t), t != 0
	case int:
		return int64(t), t != 0
	default:
		return 0, false
	}
}

// AllMachinesResult mirrors routes/maintenance.js's
// computeAllMachinesMaintenance() return shape.
type AllMachinesResult struct {
	All      bool                 `json:"all"`
	Machines []MachineMaintenance `json:"machines"`
	Global   map[string]Stat      `json:"global"`
}

// MachineMaintenance is one entry of AllMachinesResult.Machines.
type MachineMaintenance struct {
	MachineID   int64           `json:"machineId"`
	MachineName string          `json:"machineName"`
	Tasks       map[string]Stat `json:"tasks"`
}

// ComputeAllMachinesMaintenance ports routes/maintenance.js's
// computeAllMachinesMaintenance() (#392): per-machine-scoped tasks grouped
// under `machines[]`, shared-equipment tasks computed once under `global`.
func ComputeAllMachinesMaintenance(repo *Repository, shotsRepo *shots.Repository, registry *machines.Registry) (AllMachinesResult, error) {
	if err := registry.EnsureDefaultMachine(); err != nil {
		return AllMachinesResult{}, err
	}
	all, err := registry.ListMachines()
	if err != nil {
		return AllMachinesResult{}, err
	}

	perMachine := make([]MachineMaintenance, 0, len(all))
	for _, m := range all {
		maint, err := repo.GetMaintenance(m.ID)
		if err != nil {
			return AllMachinesResult{}, err
		}
		stats, err := ComputeMaintenanceStats(shotsRepo, maint, m.ID)
		if err != nil {
			return AllMachinesResult{}, err
		}
		tasks := map[string]Stat{}
		for key, val := range stats {
			if !isGlobalMaintenanceTask(key) {
				tasks[key] = val
			}
		}
		perMachine = append(perMachine, MachineMaintenance{MachineID: m.ID, MachineName: m.Name, Tasks: tasks})
	}

	referenceMachineID := int64(1)
	if len(all) > 0 {
		referenceMachineID = all[0].ID
	}
	referenceMaint, err := repo.GetMaintenance(referenceMachineID)
	if err != nil {
		return AllMachinesResult{}, err
	}
	referenceStats, err := ComputeMaintenanceStats(shotsRepo, referenceMaint, referenceMachineID)
	if err != nil {
		return AllMachinesResult{}, err
	}
	global := map[string]Stat{}
	for key, val := range referenceStats {
		if isGlobalMaintenanceTask(key) {
			global[key] = val
		}
	}

	return AllMachinesResult{All: true, Machines: perMachine, Global: global}, nil
}
