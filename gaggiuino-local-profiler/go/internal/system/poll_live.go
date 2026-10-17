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
	defaultID, _ := p.defaultMachineID()
	return p.buildLiveDataResponseFor(defaultID)
}

// buildLiveDataResponseFor is buildLiveDataResponse for an already-resolved
// default machine id — the poll tick resolves the default machine once and
// passes its id down instead of re-querying the registry (#1616).
func (p *Poller) buildLiveDataResponseFor(defaultID int64) LiveData {
	// #902 idle stats: read the per-tick machineStatus (RuntimeState.mu
	// first, then p.state.mu — the fixed lock ordering, see RuntimeState's
	// doc comment). Get() releases before p.state.mu is taken below.
	rt := p.runtime.Get()
	var temp, targetTemp, pressure *float64
	var waterLevel *int
	// #1409: never nil, so machineWarnings is always a JSON array.
	warnings := []string{}
	var updateAvailable bool
	if rt.MachineStatus != nil {
		t := rt.MachineStatus.Temperature
		tt := rt.MachineStatus.TargetTemperature
		pr := rt.MachineStatus.Pressure
		temp, targetTemp, pressure = &t, &tt, &pr
		waterLevel = rt.MachineStatus.WaterLevel // already *int, nil when HasWaterSensor=false (wl field not parsed)
		warnings = append([]string{}, rt.MachineStatus.Warnings...)
		updateAvailable = rt.MachineStatus.UpdateAvailable
	}

	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	var dp *liveDatapoints
	profileName := ""
	isLive := p.state.liveAccum != nil
	if p.state.liveAccum != nil {
		dp = copyDatapoints(&p.state.liveAccum.datapoints)
		profileName = p.state.liveAccum.profileName
	}
	var steamDP, flushDP, descaleDP *modeDatapoints
	if p.state.steamAccum != nil {
		steamDP = copyModeDatapoints(&p.state.steamAccum.datapoints)
	}
	if p.state.flushAccum != nil {
		flushDP = copyModeDatapoints(&p.state.flushAccum.datapoints)
	}
	if p.state.descaleAccum != nil {
		descaleDP = copyModeDatapoints(&p.state.descaleAccum.datapoints)
	}
	var machineReachable *bool
	// #1324: copy the control snapshot (including its slice) under the lock,
	// same copy-under-lock-then-hand-out-lock-free reasoning as copyDatapoints
	// above — the JSON for this LiveData may be marshalled after this returns.
	var machineControl *machines.ControlState
	if ms := p.state.machines[defaultID]; ms != nil {
		machineReachable = ms.reachable
		if ms.control != nil {
			ctrl := *ms.control
			ctrl.BrewConfirm = append([]string(nil), ms.control.BrewConfirm...)
			machineControl = &ctrl
		}
	}
	return LiveData{
		IsLive:           isLive,
		ProfileName:      profileName,
		Datapoints:       dp,
		Seq:              p.state.liveSeq,
		MachineReachable: machineReachable,

		IsSteaming:      p.state.steamAccum != nil,
		SteamSeq:        p.state.steamSeq,
		SteamDatapoints: steamDP,
		IsFlushing:      p.state.flushAccum != nil,
		FlushSeq:        p.state.flushSeq,
		FlushDatapoints: flushDP,

		IsDescaling:       p.state.descaleAccum != nil,
		DescaleSeq:        p.state.descaleSeq,
		DescaleDatapoints: descaleDP,

		Temperature:       temp,
		TargetTemperature: targetTemp,
		Pressure:          pressure,
		WaterLevel:        waterLevel,

		MachineWarnings:        warnings,
		MachineUpdateAvailable: updateAvailable,

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
// resolved default machine (see buildLiveDataResponseFor).
func (p *Poller) emitLiveSnapshotFor(defaultID int64) {
	p.hub.Publish(sse.Event{Type: sse.EventLiveSnapshot, Data: p.buildLiveDataResponseFor(defaultID)})
}
