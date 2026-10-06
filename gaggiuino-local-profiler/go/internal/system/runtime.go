package system

import "sync"

// RuntimeState holds per-machine polling/preheat state. #549's
// hard-single-machine assumption holds throughout this package: Poller only
// ever drives one instance, obtained once at construction.
//
// Every field is unexported and reached only through the locked methods
// below, because Poller's 1s poll tick, the 30s HA-check tick, the 30s
// preheat tick, and concurrent HTTP handler reads (GET /api/machine/status,
// /api/preheat, /api/live/data) all touch this concurrently.
//
// # Lock ordering with Poller.state (pollGlobalState, see poll.go)
//
// preheat.go's buildPreheatResponse/savePreheatState/checkReadyByPreheat
// each read from both this struct's mu AND Poller.state's mu to assemble
// one coherent snapshot (two independently mutexed structs holding one
// logical "preheat state," a deliberate split rather than a merge). Every
// call site today acquires and fully releases one lock before touching the
// other — neither is ever held while acquiring the other, so there is no
// live deadlock. If a future change ever needs both held at once, take them
// in this fixed order to keep it that way: this struct's mu (RuntimeState)
// FIRST, Poller.state's mu (pollGlobalState) SECOND — matching the majority
// of today's call sites (buildPreheatResponse, savePreheatState).
// checkReadyByPreheat currently does state-then-runtime, but never nested, so
// it isn't a counterexample to this ordering rule.
type RuntimeState struct {
	mu sync.Mutex

	machineOn         bool
	standby           bool
	currentTemp       *float64
	currentTargetTemp *float64
	tempHistory       []float64
	switchOnAt        *int64 // epoch ms, nil = never switched on this session
	switchOffAt       *int64 // epoch ms, nil = never switched off this session
	stabilityReady    bool
	machineStatus     *MachineStatus
}

// NewRuntimeState returns a zero-value RuntimeState, ready to use.
func NewRuntimeState() *RuntimeState {
	return &RuntimeState{}
}

// Snapshot is a point-in-time, lock-free copy of the fields
// buildPreheatResponse/buildLiveDataResponse/the machine/status handler
// need — computed once under the lock, then read freely.
type Snapshot struct {
	MachineOn         bool
	Standby           bool
	CurrentTemp       *float64
	CurrentTargetTemp *float64
	SwitchOnAt        *int64
	SwitchOffAt       *int64
	StabilityReady    bool
	MachineStatus     *MachineStatus
}

// Get returns a Snapshot of every field.
func (rs *RuntimeState) Get() Snapshot {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return Snapshot{
		MachineOn:         rs.machineOn,
		Standby:           rs.standby,
		CurrentTemp:       rs.currentTemp,
		CurrentTargetTemp: rs.currentTargetTemp,
		SwitchOnAt:        rs.switchOnAt,
		SwitchOffAt:       rs.switchOffAt,
		StabilityReady:    rs.stabilityReady,
		MachineStatus:     rs.machineStatus,
	}
}

// SetMachineOn sets the machine's on/off state (checkAndApplyMachinePower).
func (rs *RuntimeState) SetMachineOn(on bool) {
	rs.mu.Lock()
	rs.machineOn = on
	rs.mu.Unlock()
}

// SetStandby sets whether the machine reports its own standby/sleep mode
// (#1498). Only the GaggiMate adapter ever drives this true.
func (rs *RuntimeState) SetStandby(on bool) {
	rs.mu.Lock()
	rs.standby = on
	rs.mu.Unlock()
}

// SetMachineStatus replaces the cached machine status wholesale (never
// mutated in place, so the returned pointer from a prior Get() stays
// valid/immutable for its caller even after a later SetMachineStatus).
func (rs *RuntimeState) SetMachineStatus(s *MachineStatus) {
	rs.mu.Lock()
	rs.machineStatus = s
	rs.mu.Unlock()
}

// SetCurrentTemps only overwrites a field when a reading is present — an
// absent reading leaves the previous value in place rather than clobbering it
// with 0 (nil, not the zero value, is this package's "absent").
func (rs *RuntimeState) SetCurrentTemps(temp, targetTemp *float64) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if temp != nil {
		rs.currentTemp = temp
	}
	if targetTemp != nil {
		rs.currentTargetTemp = targetTemp
	}
}

// PushTempHistory appends a reading, capped at tempHistoryMax, dropping the
// oldest entry once full.
func (rs *RuntimeState) PushTempHistory(temp float64) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.tempHistory = append(rs.tempHistory, temp)
	if len(rs.tempHistory) > tempHistoryMax {
		rs.tempHistory = rs.tempHistory[1:]
	}
}

// ClearTempHistory empties the temperature history.
func (rs *RuntimeState) ClearTempHistory() {
	rs.mu.Lock()
	rs.tempHistory = nil
	rs.mu.Unlock()
}

// isTempStableLocked reports whether the last tempStableMin readings all fall
// within tempStableVar °C of each other. Must be called with rs.mu already
// held (only preheat.go's buildPreheatResponse-adjacent callers use it, always
// via the locked helpers below).
func (rs *RuntimeState) isTempStableLocked() bool {
	if len(rs.tempHistory) < tempStableMin {
		return false
	}
	window := rs.tempHistory[len(rs.tempHistory)-tempStableMin:]
	min, max := window[0], window[0]
	for _, v := range window[1:] {
		if v < min {
			min = v
		}
		if v > max {
			max = v
		}
	}
	return max-min <= tempStableVar
}

// IsTempStable reports reading stability for external callers.
func (rs *RuntimeState) IsTempStable() bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.isTempStableLocked()
}

// SetSwitchOnAt/SetSwitchOffAt/SetStabilityReady set the corresponding
// preheat-session fields.
func (rs *RuntimeState) SetSwitchOnAt(at *int64) {
	rs.mu.Lock()
	rs.switchOnAt = at
	rs.mu.Unlock()
}

func (rs *RuntimeState) SetSwitchOffAt(at *int64) {
	rs.mu.Lock()
	rs.switchOffAt = at
	rs.mu.Unlock()
}

func (rs *RuntimeState) SetStabilityReady(ready bool) {
	rs.mu.Lock()
	rs.stabilityReady = ready
	rs.mu.Unlock()
}

// IsStillWarm reports whether a resumed session is still warm — see
// derive.go for the pure implementation this locks around.
func (rs *RuntimeState) IsStillWarm(nowMs int64) bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return isStillWarm(rs.currentTemp, rs.switchOnAt, rs.switchOffAt, nowMs)
}
