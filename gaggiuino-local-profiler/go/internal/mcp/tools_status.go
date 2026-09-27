package mcp

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
)

// MachineStatus is the narrow, read-only slice of internal/system.Poller
// the status tool needs. Keeping it an interface (rather than depending on
// *system.Poller directly) lets tests fake the snapshot without a live
// poller — the tools never call the machine, they only read what the
// poller last observed.
type MachineStatus interface {
	StatusInfo() system.StatusInfo
	PreheatInfo() (ready bool, remainingMin int)
}

type maintenanceStatusInput struct {
	MachineID int64 `json:"machine_id,omitempty" jsonschema:"only this machine's tasks; omit or 0 for every machine"`
}

type maintenanceTaskStatus struct {
	Task           string  `json:"task" jsonschema:"task key, e.g. descaling, backflush, grinder_<id> or custom_..."`
	Label          string  `json:"label,omitempty" jsonschema:"human label for a custom task"`
	GrinderName    string  `json:"grinder_name,omitempty" jsonschema:"grinder a grinder_* task belongs to"`
	Status         string  `json:"status" jsonschema:"due, soon or ok; never when the task has never been marked done"`
	Pct            float64 `json:"pct" jsonschema:"progress toward the threshold, 0..1"`
	DaysSince      *int64  `json:"days_since,omitempty" jsonschema:"days since the task was last marked done"`
	ShotsSince     int     `json:"shots_since" jsonschema:"shots pulled since the task was last marked done"`
	ThresholdShots *int64  `json:"threshold_shots,omitempty" jsonschema:"shot threshold, when the task tracks one"`
	ThresholdDays  *int64  `json:"threshold_days,omitempty" jsonschema:"day threshold, when the task tracks one"`
	ThresholdG     *int64  `json:"threshold_g,omitempty" jsonschema:"grams threshold, when the task tracks one"`
	GramsSince     *int64  `json:"grams_since,omitempty" jsonschema:"grams ground since last done, for grinder tasks"`
	LastDone       string  `json:"last_done,omitempty" jsonschema:"when the task was last marked done"`
	Disabled       bool    `json:"disabled,omitempty" jsonschema:"whether the task is disabled"`
}

type machineMaintenanceStatus struct {
	MachineID   int64                   `json:"machine_id" jsonschema:"machine id"`
	MachineName string                  `json:"machine_name" jsonschema:"machine name"`
	Tasks       []maintenanceTaskStatus `json:"tasks" jsonschema:"this machine's own (non-shared) tasks"`
}

type maintenanceStatusOutput struct {
	Machines []machineMaintenanceStatus `json:"machines" jsonschema:"per-machine maintenance state"`
	Global   []maintenanceTaskStatus    `json:"global" jsonschema:"shared-equipment tasks (water filter and grinder tasks) that are not scoped to one machine"`
}

type machineStatusInput struct {
	MachineID int64 `json:"machine_id,omitempty" jsonschema:"only this machine; omit or 0 for every configured machine"`
}

type machineStatusEntry struct {
	ID                  int64  `json:"id" jsonschema:"machine id"`
	Name                string `json:"name" jsonschema:"machine name"`
	Type                string `json:"type" jsonschema:"machine type, gaggiuino or gaggimate"`
	IsDefault           bool   `json:"is_default" jsonschema:"whether this is the default machine"`
	Enabled             bool   `json:"enabled" jsonschema:"whether the machine is enabled in the registry"`
	Reachable           *bool  `json:"reachable,omitempty" jsonschema:"whether the last poll reached the machine; only set for the polled (default) machine"`
	LastError           string `json:"last_error,omitempty" jsonschema:"last polling error, when the machine was unreachable"`
	LastSuccess         string `json:"last_success,omitempty" jsonschema:"RFC 3339 time of the last successful poll"`
	FirmwareVersion     string `json:"firmware_version,omitempty" jsonschema:"firmware version cached from the last successful poll"`
	PreheatReady        *bool  `json:"preheat_ready,omitempty" jsonschema:"whether the preheat window has elapsed"`
	PreheatRemainingMin *int   `json:"preheat_remaining_min,omitempty" jsonschema:"minutes remaining before preheat is ready"`
}

type machineStatusOutput struct {
	Machines        []machineStatusEntry `json:"machines" jsonschema:"the requested machines with their registry data"`
	PolledMachineID *int64               `json:"polled_machine_id,omitempty" jsonschema:"the default machine the status and preheat fields describe"`
}

func registerStatusTools(srv *mcpsdk.Server, deps Deps) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "get_maintenance_status",
		Title:       "Get maintenance status",
		Description: "Report the user's espresso-machine maintenance state: every task with its due state (due/soon/ok/never), progress toward its threshold, and shots/days/grams since it was last marked done. Omit machine_id for every machine plus the shared global tasks (water filter, grinders); pass machine_id for just one machine. Read-only.",
		Annotations: readOnlyAnnotations("Get maintenance status"),
		InputSchema: mustSchema[maintenanceStatusInput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in maintenanceStatusInput) (*mcpsdk.CallToolResult, maintenanceStatusOutput, error) {
		out, err := getMaintenanceStatus(deps, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "get_machine_status",
		Title:       "Get machine status",
		Description: "List the user's configured espresso machines (id, name, type, default flag) plus the reachability, last polling error, last successful poll time (RFC 3339) and cached firmware version of the default machine, and whether its preheat is ready and how many minutes remain. Read-only: this never contacts the machine.",
		Annotations: readOnlyAnnotations("Get machine status"),
		InputSchema: mustSchema[machineStatusInput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in machineStatusInput) (*mcpsdk.CallToolResult, machineStatusOutput, error) {
		out, err := getMachineStatus(deps, in)
		return nil, out, err
	})
}

func getMaintenanceStatus(deps Deps, in maintenanceStatusInput) (maintenanceStatusOutput, error) {
	if deps.Maintenance == nil || deps.ShotsRepo == nil || deps.Registry == nil {
		return maintenanceStatusOutput{}, fmt.Errorf("maintenance data is not available")
	}
	out := maintenanceStatusOutput{Machines: []machineMaintenanceStatus{}, Global: []maintenanceTaskStatus{}}
	if in.MachineID == 0 {
		all, err := maintenance.ComputeAllMachinesMaintenance(deps.Maintenance, deps.ShotsRepo, deps.Registry)
		if err != nil {
			log.Printf("mcp: get_maintenance_status: %v", err)
			return maintenanceStatusOutput{}, fmt.Errorf("could not read maintenance data; try again")
		}
		for _, m := range all.Machines {
			out.Machines = append(out.Machines, machineMaintenanceStatus{
				MachineID:   m.MachineID,
				MachineName: m.MachineName,
				Tasks:       toTaskStatuses(m.Tasks),
			})
		}
		out.Global = toTaskStatuses(all.Global)
		return out, nil
	}

	machine, err := deps.Registry.GetMachine(in.MachineID)
	if err != nil {
		log.Printf("mcp: get_maintenance_status: machine %d: %v", in.MachineID, err)
		return maintenanceStatusOutput{}, fmt.Errorf("could not read maintenance data; try again")
	}
	if machine == nil {
		return maintenanceStatusOutput{}, fmt.Errorf("machine %d not found; use get_machine_status to list machine ids", in.MachineID)
	}
	maint, err := deps.Maintenance.GetMaintenance(in.MachineID)
	if err != nil {
		log.Printf("mcp: get_maintenance_status: reading tasks for machine %d: %v", in.MachineID, err)
		return maintenanceStatusOutput{}, fmt.Errorf("could not read maintenance data; try again")
	}
	stats, err := maintenance.ComputeMaintenanceStats(deps.ShotsRepo, maint, in.MachineID)
	if err != nil {
		log.Printf("mcp: get_maintenance_status: computing stats for machine %d: %v", in.MachineID, err)
		return maintenanceStatusOutput{}, fmt.Errorf("could not read maintenance data; try again")
	}
	machineTasks := map[string]maintenance.Stat{}
	globalTasks := map[string]maintenance.Stat{}
	for key, stat := range stats {
		if isGlobalMaintenanceKey(key) {
			globalTasks[key] = stat
		} else {
			machineTasks[key] = stat
		}
	}
	out.Machines = append(out.Machines, machineMaintenanceStatus{
		MachineID:   machine.ID,
		MachineName: machine.Name,
		Tasks:       toTaskStatuses(machineTasks),
	})
	out.Global = toTaskStatuses(globalTasks)
	return out, nil
}

// isGlobalMaintenanceKey mirrors maintenance.isGlobalMaintenanceTask: the
// water filter and every grinder_* task track shared equipment, not one
// machine.
func isGlobalMaintenanceKey(key string) bool {
	return key == "waterfilter" || strings.HasPrefix(key, "grinder_")
}

func toTaskStatuses(tasks map[string]maintenance.Stat) []maintenanceTaskStatus {
	keys := make([]string, 0, len(tasks))
	for key := range tasks {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]maintenanceTaskStatus, 0, len(keys))
	for _, key := range keys {
		out = append(out, toTaskStatus(key, tasks[key]))
	}
	return out
}

func toTaskStatus(key string, stat maintenance.Stat) maintenanceTaskStatus {
	out := maintenanceTaskStatus{
		Task:        key,
		Label:       statString(stat, "label"),
		GrinderName: statString(stat, "grinderName"),
		Status:      statString(stat, "status"),
		LastDone:    statString(stat, "lastDate"),
	}
	if v, ok := statFloat(stat, "pct"); ok {
		out.Pct = v
	}
	if v, ok := statInt(stat, "daysSince"); ok {
		out.DaysSince = &v
	}
	if v, ok := statInt(stat, "shotsSince"); ok {
		out.ShotsSince = boundedInt(v)
	}
	if v, ok := statInt(stat, "threshold_shots"); ok {
		out.ThresholdShots = &v
	}
	if v, ok := statInt(stat, "threshold_days"); ok {
		out.ThresholdDays = &v
	}
	if v, ok := statInt(stat, "threshold_g"); ok {
		out.ThresholdG = &v
	}
	if v, ok := statInt(stat, "gramsSince"); ok {
		out.GramsSince = &v
	}
	if b, ok := stat["disabled"].(bool); ok {
		out.Disabled = b
	}
	return out
}

func getMachineStatus(deps Deps, in machineStatusInput) (machineStatusOutput, error) {
	if deps.Registry == nil {
		return machineStatusOutput{}, fmt.Errorf("the machine registry is not available")
	}
	var (
		list []machines.Machine
		err      error
	)
	if in.MachineID == 0 {
		if err = deps.Registry.EnsureDefaultMachine(); err != nil {
			log.Printf("mcp: get_machine_status: ensuring default machine: %v", err)
			return machineStatusOutput{}, fmt.Errorf("could not read machines; try again")
		}
		list, err = deps.Registry.ListMachines()
		if err != nil {
			log.Printf("mcp: get_machine_status: listing machines: %v", err)
			return machineStatusOutput{}, fmt.Errorf("could not read machines; try again")
		}
	} else {
		m, gerr := deps.Registry.GetMachine(in.MachineID)
		if gerr != nil {
			log.Printf("mcp: get_machine_status: machine %d: %v", in.MachineID, gerr)
			return machineStatusOutput{}, fmt.Errorf("could not read machines; try again")
		}
		if m == nil {
			return machineStatusOutput{}, fmt.Errorf("machine %d not found; omit machine_id to list every machine", in.MachineID)
		}
		list = []machines.Machine{*m}
	}
	defaultID, err := defaultMachineID(deps.Registry)
	if err != nil {
		log.Printf("mcp: get_machine_status: resolving default machine: %v", err)
		return machineStatusOutput{}, fmt.Errorf("could not read machines; try again")
	}
	out := machineStatusOutput{Machines: make([]machineStatusEntry, 0, len(list))}
	if defaultID != 0 {
		id := defaultID
		out.PolledMachineID = &id
	}
	for _, m := range list {
		entry := machineStatusEntry{
			ID:        m.ID,
			Name:      m.Name,
			Type:      m.Type,
			IsDefault: m.IsDefault,
			Enabled:   m.Enabled,
		}
		if m.ID == defaultID && deps.Poller != nil {
			populateMachineStatus(&entry, deps.Poller)
		}
		out.Machines = append(out.Machines, entry)
	}
	return out, nil
}

// populateMachineStatus copies the poller's snapshot onto the default
// machine's entry. The poller only tracks one machine, so this is only
// called for the default id.
func populateMachineStatus(entry *machineStatusEntry, poller MachineStatus) {
	info := poller.StatusInfo()
	entry.Reachable = info.MachineReachable
	if info.LastMachineError != nil {
		entry.LastError = *info.LastMachineError
	}
	if info.LastMachineSuccess != nil && *info.LastMachineSuccess > 0 {
		entry.LastSuccess = time.UnixMilli(*info.LastMachineSuccess).UTC().Format(time.RFC3339)
	}
	if info.CachedMachineVersion != nil {
		entry.FirmwareVersion = *info.CachedMachineVersion
	}
	ready, remaining := poller.PreheatInfo()
	entry.PreheatReady = &ready
	entry.PreheatRemainingMin = &remaining
}

func defaultMachineID(registry *machines.Registry) (int64, error) {
	m, err := registry.GetDefaultMachine()
	if err != nil {
		return 0, err
	}
	if m == nil {
		return 0, nil
	}
	return m.ID, nil
}

func statString(stat maintenance.Stat, key string) string {
	v, _ := stat[key].(string)
	return v
}

func statFloat(stat maintenance.Stat, key string) (float64, bool) {
	return entityFloat(stat, key)
}

func statInt(stat maintenance.Stat, key string) (int64, bool) {
	return entityInt(stat, key)
}

// boundedInt narrows an int64 to int for a value that is always a small,
// non-negative count, clamping instead of truncating (CodeQL
// go/incorrect-integer-conversion).
func boundedInt(v int64) int {
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	return int(v)
}
