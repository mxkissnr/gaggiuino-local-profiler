package system

import (
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// buildLiveDataResponse is the single source of truth for GET /api/live/data
// and the live-snapshot SSE payload. Must
// return a value wholly independent of p.state.liveAccum once unlocked: a
// caller (emitLiveSnapshot -> Hub.Publish -> a per-subscriber buffered
// channel, see internal/sse) can hold onto this LiveData and json.Marshal
// it arbitrarily long after this call returns, concurrently with pollTick
// appending to the very same datapoints slices under its own lock (#901
// code review — a `go test -race` reproduction: returning a pointer into
// the locked struct here, as this used to, is a data race between that
// later Marshal and the next tick's writes). copyDatapoints below takes a
// deep copy of the slices while still holding the lock, exactly the
// "copy under lock, then hand out lock-free" pattern
// internal/machines/live.go's GetLiveSensorSnapshot/GetLiveSystemState
// follow for their own cached values (those are safe returning a bare
// pointer instead, since a fresh poll replaces sensorSnap/sysState
// wholesale rather than mutating the previous value in place — this
// package's own RuntimeState.SetMachineStatus relies on the same
// never-mutated-after-set invariant, see its doc comment).
func (p *Poller) buildLiveDataResponse() LiveData {
	return p.buildLiveDataResponseFor(p.defaultTarget())
}

// buildLiveDataResponseFor is buildLiveDataResponse for an already-resolved
// machine — the poll tick resolves its machine once and passes it down
// instead of re-querying the registry (#1616); #2247 builds it for any
// machine from that machine's own runtime and slots.
func (p *Poller) buildLiveDataResponseFor(t liveTarget) LiveData {
	// #902 idle stats: read the per-tick machineStatus (RuntimeState.mu
	// first, then p.state.mu — the fixed lock ordering, see RuntimeState's
	// doc comment). Get() releases before p.state.mu is taken below.
	rt := p.runtimeFor(t).Get()
	var temp, targetTemp, pressure *float64
	var waterLevel *int
	// #1409: never nil, so machineWarnings is always a JSON array.
	warnings := []string{}
	var updateAvailable bool
	var systemState string
	var systemErrorCode int
	if rt.MachineStatus != nil {
		t := rt.MachineStatus.Temperature
		tt := rt.MachineStatus.TargetTemperature
		pr := rt.MachineStatus.Pressure
		temp, targetTemp, pressure = &t, &tt, &pr
		waterLevel = rt.MachineStatus.WaterLevel // already *int, nil when HasWaterSensor=false (wl field not parsed)
		warnings = append([]string{}, rt.MachineStatus.Warnings...)
		updateAvailable = rt.MachineStatus.UpdateAvailable
		systemState = rt.MachineStatus.SystemState
		systemErrorCode = rt.MachineStatus.SystemErrorCode
	}

	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	sl := p.state.slotsLocked(t)
	var dp *liveDatapoints
	profileName := ""
	isLive := sl.liveAccum != nil
	if sl.liveAccum != nil {
		dp = copyDatapoints(&sl.liveAccum.datapoints)
		profileName = sl.liveAccum.profileName
	}
	var steamDP, flushDP, descaleDP *modeDatapoints
	if sl.steamAccum != nil {
		steamDP = copyModeDatapoints(&sl.steamAccum.datapoints)
	}
	if sl.flushAccum != nil {
		flushDP = copyModeDatapoints(&sl.flushAccum.datapoints)
	}
	if sl.descaleAccum != nil {
		descaleDP = copyModeDatapoints(&sl.descaleAccum.datapoints)
	}
	var machineReachable *bool
	// #1324: copy the control snapshot (including its slice) under the lock,
	// same copy-under-lock-then-hand-out-lock-free reasoning as copyDatapoints
	// above — the JSON for this LiveData may be marshalled after this returns.
	var machineControl *machines.ControlState
	if ms := p.state.machines[t.id]; ms != nil {
		machineReachable = ms.reachable
		if ms.control != nil {
			ctrl := *ms.control
			ctrl.BrewConfirm = append([]string(nil), ms.control.BrewConfirm...)
			machineControl = &ctrl
		}
	}
	return LiveData{
		MachineID:        t.id,
		IsLive:           isLive,
		ProfileName:      profileName,
		Datapoints:       dp,
		Seq:              sl.liveSeq,
		MachineReachable: machineReachable,

		IsSteaming:      sl.steamAccum != nil,
		SteamSeq:        sl.steamSeq,
		SteamDatapoints: steamDP,
		IsFlushing:      sl.flushAccum != nil,
		FlushSeq:        sl.flushSeq,
		FlushDatapoints: flushDP,

		IsDescaling:       sl.descaleAccum != nil,
		DescaleSeq:        sl.descaleSeq,
		DescaleDatapoints: descaleDP,

		Temperature:       temp,
		TargetTemperature: targetTemp,
		Pressure:          pressure,
		WaterLevel:        waterLevel,

		MachineWarnings:        warnings,
		MachineUpdateAvailable: updateAvailable,
		MachineSystemState:     systemState,
		MachineSystemErrorCode: systemErrorCode,

		MachineControl: machineControl,
	}
}

// copyModeDatapoints deep-copies src's slices — same race reasoning as
// copyDatapoints (see buildLiveDataResponse's doc comment).
func copyModeDatapoints(src *modeDatapoints) *modeDatapoints {
	return &modeDatapoints{
		TimeInMode:  append([]int(nil), src.TimeInMode...),
		Pressure:    append([]int(nil), src.Pressure...),
		Temperature: append([]int(nil), src.Temperature...),
	}
}

// copyDatapoints deep-copies src's slices — see buildLiveDataResponse's doc
// comment for why a shallow copy (or no copy at all) isn't safe here.
func copyDatapoints(src *liveDatapoints) *liveDatapoints {
	return &liveDatapoints{
		TimeInShot:        append([]int(nil), src.TimeInShot...),
		Pressure:          append([]int(nil), src.Pressure...),
		Temperature:       append([]int(nil), src.Temperature...),
		ShotWeight:        append([]int(nil), src.ShotWeight...),
		WeightFlow:        append([]int(nil), src.WeightFlow...),
		PumpFlow:          append([]int(nil), src.PumpFlow...),
		TargetTemperature: append([]int(nil), src.TargetTemperature...),
	}
}

// LiveData is the exported form of buildLiveDataResponse, for cmd/server's
// SSE-priming wiring.
func (p *Poller) LiveData() LiveData { return p.buildLiveDataResponse() }

// emitLiveSnapshot publishes the current buildLiveDataResponse() onto the SSE
// hub as EventLiveSnapshot. This is this package's sole producer of that event
// (see doc.go's "Live-snapshot production" section): machines/live.go's own WS
// session cache no longer publishes directly, since its raw
// {machineHost, sensorSnap}/{machineHost, sysState} shape doesn't match
// openapi.yaml's LiveData schema this endpoint/event are bound to. Deliberately
// simpler than #708's optimization (an immediate push the instant a fresh
// WS/MQTT sample arrives, on top of the 1s tick) — every push here is
// tick-driven only; see doc.go.
func (p *Poller) emitLiveSnapshot() {
	p.hub.Publish(sse.Event{Type: sse.EventLiveSnapshot, Data: p.buildLiveDataResponse()})
}

// emitLiveSnapshotFor is emitLiveSnapshot for the poll tick's already
// resolved machine (see buildLiveDataResponseFor). The default machine's
// snapshot goes to every subscriber as before; any other machine's only to
// the subscribers watching it (#2247), so glp-integration keeps seeing the
// default machine alone.
func (p *Poller) emitLiveSnapshotFor(t liveTarget) {
	p.hub.Publish(sse.Event{Type: sse.EventLiveSnapshot, Data: p.buildLiveDataResponseFor(t), MachineID: t.scope()})
}
