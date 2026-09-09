package web

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// maintTaskOrder is the fixed display order for the five static tasks —
// mirrors public-src/constants.js's MAINT_META insertion order (descaling,
// backflush, grouphead, gaskets, waterfilter). Any grinder_<id> tasks in the
// stats map (one per currently registered grinder, synthesized by
// maintenance.Repository.GetMaintenance) are appended after these, sorted
// numerically by grinder id.
var maintTaskOrder = []string{"descaling", "backflush", "grouphead", "gaskets", "waterfilter"}

var maintTaskTitles = map[string]string{
	"descaling":   "Descaling",
	"backflush":   "Backflush",
	"grouphead":   "Grouphead",
	"gaskets":     "Gaskets",
	"waterfilter": "Water filter",
}

// maintTiles builds every task in stats as a templates.MaintTile, in
// maintTaskOrder followed by grinder_<id> tasks sorted by id.
func maintTiles(stats map[string]maintenance.Stat) []templates.MaintTile {
	keys := make([]string, 0, len(stats))
	seen := make(map[string]bool, len(maintTaskOrder))
	for _, k := range maintTaskOrder {
		if _, ok := stats[k]; ok {
			keys = append(keys, k)
			seen[k] = true
		}
	}
	grinderKeys := make([]string, 0, len(stats))
	for k := range stats {
		if !seen[k] {
			grinderKeys = append(grinderKeys, k)
		}
	}
	sort.Slice(grinderKeys, func(i, j int) bool {
		return grinderNumericSuffix(grinderKeys[i]) < grinderNumericSuffix(grinderKeys[j])
	})
	keys = append(keys, grinderKeys...)

	tiles := make([]templates.MaintTile, 0, len(keys))
	for _, k := range keys {
		tiles = append(tiles, toMaintTile(k, stats[k]))
	}
	return tiles
}

func grinderNumericSuffix(key string) int64 {
	n, _ := strconv.ParseInt(strings.TrimPrefix(key, "grinder_"), 10, 64)
	return n
}

// toMaintTile builds a templates.MaintTile from one internal/maintenance.Stat
// entry — the Go-side equivalent of public-src/views/maintenance.js's
// _buildMaintMiniTile's field extraction.
func toMaintTile(task string, stat maintenance.Stat) templates.MaintTile {
	status, _ := stat["status"].(string)
	tile := templates.MaintTile{Task: task, Status: status}

	if title, ok := maintTaskTitles[task]; ok {
		tile.Title = title
	} else if name, ok := stat["grinderName"].(string); ok && name != "" {
		tile.Title = name
	} else {
		tile.Title = task
	}

	tile.Pct = floatVal(stat["pct"])
	shotsSince := intVal(stat["shotsSince"])
	if v, ok := int64Val(stat["threshold_shots"]); ok {
		tile.ThresholdShots = &v
	}
	if v, ok := int64Val(stat["threshold_days"]); ok {
		tile.ThresholdDays = &v
	}
	daysSince, hasDaysSince := int64Val(stat["daysSince"])

	switch {
	case status == "never":
		tile.Detail = "never done"
	case tile.ThresholdShots != nil:
		tile.Detail = fmt.Sprintf("%d / %d shots", shotsSince, *tile.ThresholdShots)
	case tile.ThresholdDays != nil && hasDaysSince:
		tile.Detail = fmt.Sprintf("%d / %d days", daysSince, *tile.ThresholdDays)
	default:
		tile.Detail = "never done"
	}
	return tile
}

// floatVal/intVal/int64Val tolerate the two numeric shapes every map[string]any
// value coming out of internal/maintenance's Stat can carry — a freshly
// computed float64 (json-number-shaped, ComputeMaintenanceStats' own
// pct/shotsSince/daysSince fields) or, for daysSince specifically, an int64
// (jsFloorDivDays' own return type) — mirrors view_orders.go's orderNumber
// helper for the same reason.
func floatVal(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return 0
}

func intVal(v any) int {
	return int(floatVal(v))
}

func int64Val(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case int:
		return int64(t), true
	}
	return 0, false
}
