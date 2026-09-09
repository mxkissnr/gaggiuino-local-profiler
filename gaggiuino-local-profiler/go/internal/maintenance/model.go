package maintenance

import (
	"regexp"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// Task is one maintenance task's tracked state — a map, not a struct, for
// the same reason shots.Shot/library.Entity/orders.Order are: the shape
// varies (grinder tasks additionally carry grinderName; MAINTENANCE_DEFAULTS
// entries don't all share the same field set either — grouphead/gaskets/
// waterfilter have no machineSyncedAt).
type Task = map[string]any

// staticMaintenanceTasks mirrors lib/constants.js's
// STATIC_MAINTENANCE_TASKS.
var staticMaintenanceTasks = map[string]bool{
	"descaling": true, "backflush": true, "grouphead": true, "gaskets": true, "waterfilter": true,
}

// maintenanceDefaults mirrors lib/constants.js's MAINTENANCE_DEFAULTS — the
// zero-value shape getMaintenance() fills in for a task that has no row in
// the `maintenance` table yet. Returned as a fresh map on every call (like
// the Node original's `JSON.parse(JSON.stringify(MAINTENANCE_DEFAULTS))`)
// so callers can freely mutate their own copy.
func maintenanceDefaults() map[string]Task {
	return map[string]Task{
		"descaling":   {"lastDate": nil, "threshold_shots": 200, "threshold_days": 60, "machineSyncedAt": nil},
		"backflush":   {"lastDate": nil, "threshold_shots": 20, "threshold_days": nil, "machineSyncedAt": nil},
		"grouphead":   {"lastDate": nil, "threshold_shots": nil, "threshold_days": 180},
		"gaskets":     {"lastDate": nil, "threshold_shots": nil, "threshold_days": 365},
		"waterfilter": {"lastDate": nil, "threshold_shots": nil, "threshold_days": 90},
	}
}

// isGlobalMaintenanceTask ports lib/constants.js's isGlobalMaintenanceTask:
// waterfilter and grinder_* tasks track shared equipment (one water filter
// / one grinder used across machines, #338) — they never split per machine
// and always live under the sentinel machine_id 1, regardless of which
// machine is currently active.
func isGlobalMaintenanceTask(key string) bool {
	if key == "waterfilter" {
		return true
	}
	return len(key) > 8 && key[:8] == "grinder_"
}

var grinderTaskRe = regexp.MustCompile(`^grinder_(\d+)$`)

// canonicalTask ports routes/maintenance.js's canonicalTask(raw): returns a
// program-owned string for a valid task, or ("", false). Never returns the
// raw request string for a grinder task — callers must index maps with the
// returned value, not the request param, so the object key is never
// attacker-derived (severs the prototype-pollution taint chain Node's own
// comment flags; Go maps have no prototype-pollution equivalent, but the
// "only ever a program-owned key" discipline is kept for parity and because
// it's simply the correct thing to do regardless).
func canonicalTask(libRepo *library.Repository, raw string) (string, bool) {
	if staticMaintenanceTasks[raw] {
		return raw, true
	}
	m := grinderTaskRe.FindStringSubmatch(raw)
	if m == nil {
		return "", false
	}
	id, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return "", false
	}
	lib, err := libRepo.GetLibrary()
	if err != nil {
		return "", false
	}
	for _, g := range lib.Grinders {
		if gid, ok := grinderIDOf(g); ok && gid == id {
			return "grinder_" + strconv.FormatInt(id, 10), true
		}
	}
	return "", false
}

func grinderIDOf(g library.Entity) (int64, bool) {
	switch v := g["id"].(type) {
	case int64:
		return v, true
	case float64:
		return int64(v), true
	}
	return 0, false
}
