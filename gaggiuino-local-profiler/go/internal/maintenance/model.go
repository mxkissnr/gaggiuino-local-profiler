package maintenance

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// Task is one maintenance task's tracked state — a map, not a struct, for
// the same reason shots.Shot/library.Entity/orders.Order are: the shape
// varies (grinder tasks additionally carry grinderName; MAINTENANCE_DEFAULTS
// entries don't all share the same field set either — grouphead/gaskets/
// waterfilter have no machineSyncedAt).
type Task = map[string]any

// staticMaintenanceTasks are the program-owned static maintenance task keys.
var staticMaintenanceTasks = map[string]bool{
	"descaling": true, "backflush": true, "grouphead": true, "gaskets": true, "waterfilter": true,
}

// StaticTaskKeys returns the program-owned static maintenance task keys in a
// stable (sorted) order. These are the tasks canonicalTask accepts by name;
// grinder_<id> and custom_* keys are dynamic (they depend on the current
// library/machine state) and so cannot be enumerated here.
func StaticTaskKeys() []string {
	keys := make([]string, 0, len(staticMaintenanceTasks))
	for key := range staticMaintenanceTasks {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// maintenanceDefaults is the zero-value shape getMaintenance() fills in for
// a task that has no row in the `maintenance` table yet. Returned as a fresh
// map on every call so callers can freely mutate their own copy.
func maintenanceDefaults() map[string]Task {
	return map[string]Task{
		"descaling":   {"lastDate": nil, "threshold_shots": 200, "threshold_days": 60, "machineSyncedAt": nil},
		"backflush":   {"lastDate": nil, "threshold_shots": 20, "threshold_days": nil, "machineSyncedAt": nil},
		"grouphead":   {"lastDate": nil, "threshold_shots": nil, "threshold_days": 180},
		"gaskets":     {"lastDate": nil, "threshold_shots": nil, "threshold_days": 365},
		"waterfilter": {"lastDate": nil, "threshold_shots": nil, "threshold_days": 90},
	}
}

// isGlobalMaintenanceTask reports whether waterfilter and grinder_* tasks
// track shared equipment (one water filter / one grinder used across
// machines, #338) — they never split per machine
// and always live under the sentinel machine_id 1, regardless of which
// machine is currently active.
func isGlobalMaintenanceTask(key string) bool {
	if key == "waterfilter" {
		return true
	}
	return len(key) > 8 && key[:8] == "grinder_"
}

var grinderTaskRe = regexp.MustCompile(`^grinder_(\d+)$`)
var customTaskRe = regexp.MustCompile(`^custom_[a-z0-9_-]+$`)

// isCustomTask returns true for user-defined custom maintenance tasks.
func isCustomTask(key string) bool {
	return customTaskRe.MatchString(key)
}

// slugifyLabel converts a human label into a safe custom_ key.
// E.g. "Rückspülen mit Reiniger" → "custom_ruckspulen_mit_reiniger"
func slugifyLabel(label string) string {
	// Normalize unicode to ASCII-ish
	var b strings.Builder
	for _, r := range strings.ToLower(label) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == 'ä':
			b.WriteString("a")
		case r == 'ö':
			b.WriteString("o")
		case r == 'ü':
			b.WriteString("u")
		case r == 'ß':
			b.WriteString("ss")
		case unicode.IsSpace(r) || r == '-' || r == '_':
			b.WriteRune('_')
		}
	}
	slug := strings.Trim(b.String(), "_")
	// collapse multiple underscores
	for strings.Contains(slug, "__") {
		slug = strings.ReplaceAll(slug, "__", "_")
	}
	if slug == "" {
		return ""
	}
	return "custom_" + slug
}

// canonicalTask returns a program-owned string for a valid task, or
// ("", false). Never returns the raw request string for a grinder task —
// callers must index maps with the returned value, not the request param, so
// the object key is never attacker-derived (Go maps have no
// prototype-pollution risk, but keeping the object key program-owned is
// simply the correct thing to do).
//
// maint is the caller's already-loaded (machine-scoped) maintenance map —
// needed here because, unlike the static/grinder_N task families (whose
// validity is a program-owned constant/library lookup), a custom_* key's
// validity is "does a task with this key actually exist for this machine".
// Without checking that, a request naming an unknown or already-deleted
// custom_* key would pass the regex shape check and every write-side
// caller (taskThreshold, MarkTaskDone, postLog) would silently create a
// phantom task row instead of 404ing.
func canonicalTask(libRepo *library.Repository, maint map[string]Task, raw string) (string, bool) {
	if staticMaintenanceTasks[raw] {
		return raw, true
	}
	if customTaskRe.MatchString(raw) {
		if _, exists := maint[raw]; !exists {
			return "", false
		}
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
