package system

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
)

// pollViaGaggiuinoStatus is adapter-agnostic despite the name:
// adapter.GetStatus dispatches to the right machine adapter, and for a
// GaggiMate default that call reads the persistent evt:status cache
// (gaggimate_live.go, #952) rather than opening a fresh WebSocket every tick
// (PR #947's "GaggiMate WS hammer") —
// GetLiveSensorSnapshot/GetLiveSystemState return nil for GaggiMate, which
// deriveMachineState already tolerates. The #725 reachability-recovery catch-up
// sync and the brew-finished 3s pull are implemented (#953,
// sync_triggers.go); still not implemented (see doc.go) is recordConnectivity()'s
// debug-log summary.
func (p *Poller) pollViaGaggiuinoStatus(ctx context.Context) {
	machine, err := p.registry.GetDefaultMachine()
	if err != nil || machine == nil {
		return
	}
	// #718: no host configured anywhere -- skip cleanly, don't request against a
	// placeholder/fallback hostname, and don't touch machineReachable (nil stays
	// nil on this early-return path).
	if strings.TrimSpace(machine.Host) == "" {
		return
	}
	adapter, err := p.adapters.GetAdapter(machine)
	if err != nil {
		return
	}

	// The actual HTTP GET happens one layer down, inside the adapter
	// (internal/machines/gaggiuino_adapter.go for a Gaggiuino default), so this
	// traces the poll tick itself rather than the literal request line. Calling
	// debugLogf directly is safe here despite firing every single pollInterval
	// tick (1s): the check behind it (config.IsDebugLoggingEnabled()) goes through
	// internal/config's shared cache, which now carries its own TTL sized for
	// exactly this hot path (#977 follow-up code review, round 5 -- see
	// internal/config/debuglog.go's debugLoggingCache doc comment), so this no
	// longer needs its own throttling wrapper.
	debugLogf("poll: GET status from %s (%s)", machine.Host, machine.Type)
	status, err := adapter.GetStatus(ctx, machine)
	// The machine-traffic brewing flag is set here, once per poll tick, for every
	// adapter and fallback path: the host is normalized exactly as the counting
	// round tripper keys it, and a failed poll reports not brewing.
	brewingHost, _ := machines.NormalizeMachineHost(machine.Host)
	machines.SetMachineBrewing(brewingHost, err == nil && status.Brewing)
	if err != nil {
		p.state.mu.Lock()
		ms := p.state.machine(machine.ID)
		reachable := false
		ms.reachable = &reachable
		ms.wasReachable = &reachable
		msg := redactURLs(err.Error())
		ms.lastError = &msg
		// #1324: an unreachable machine has no machine-control snapshot.
		ms.control = nil
		p.state.mu.Unlock()
		// #1498: an unreachable machine is not in standby.
		p.runtime.SetStandby(false)
		log.Printf("system: live poll error: %v", err)
		p.emitLiveSnapshotFor(machine.ID)
		return
	}

	// #1498: reconcile the machine's own standby signal with the runtime
	// before anything below reads it. A standby GaggiMate is still reachable,
	// so live polling keeps running; without this the time-only preheat
	// countdown starts from startLivePolling and reports "ready" from a cold
	// boiler.
	p.applyStandbyTransition(time.Now().UnixMilli(), status.Standby)

	// #1324: refresh the opt-in machine-control snapshot. ControlStateFor
	// reads only the registry cache and one KV row (no network), so it runs
	// outside p.state.mu; a nil result (unsupported adapter, setting off or no
	// connected controller) simply stores null.
	ctrl, _ := machines.ControlStateFor(p.registry, adapter, machine)

	p.state.mu.Lock()
	ms := p.state.machine(machine.ID)
	ms.control = ctrl
	prevReachable := ms.wasReachable
	now := time.Now().UnixMilli()
	markReachableLocked(ms, now)
	reachable := true
	ms.wasReachable = &reachable
	if ms.version == nil {
		if ver := extractVersion(status.Raw); ver != "" {
			ms.version = &ver
			log.Printf("system: Gaggiuino firmware (from status): %s", ver)
		}
	}
	p.state.mu.Unlock()

	// #1454: one-off fetch of the machine's firmware-set name, gated to a
	// Gaggiuino (a GaggiMate reports no such setting) and to once per reachable
	// stretch. Runs after the reachability/version bookkeeping above so a
	// markReachableLocked reset is already applied.
	p.maybeFetchFirmwareName(ctx, machine, adapter)

	// #725: unreachable->reachable recovery with an outstanding sync — catch
	// up now instead of waiting for the next scheduled pull.
	p.maybeCatchUpAfterRecovery(prevReachable)

	// #608/#1447: MQTT for a Gaggiuino default machine when the Settings toggle
	// selects it, the adapter's WS session otherwise. The Gaggiuino firmware's
	// MQTT topics only ever describe a Gaggiuino, so any other machine type
	// (e.g. a GaggiMate default) reads live data from its own adapter instead
	// of being handed the Gaggiuino snapshot. When MQTT is the active transport
	// its getter is used even if it returns nil (a stale/empty MQTT cache),
	// never falling through to open a WS session.
	mqttEligible := machine.IsDefault && machine.Type == "gaggiuino"
	var sensorSnap *proto.SensorStateSnapshotDto
	var sysState *proto.SystemStateDto
	if p.liveTransport != nil {
		if snap, mqttActive := p.liveTransport.SensorSnapshot(mqttEligible); mqttActive {
			sensorSnap = snap
		} else {
			sensorSnap, _ = adapter.GetLiveSensorSnapshot(ctx, machine)
		}
		if sys, mqttActive := p.liveTransport.SystemState(mqttEligible); mqttActive {
			sysState = sys
		} else {
			sysState, _ = adapter.GetLiveSystemState(ctx, machine)
		}
	} else {
		sensorSnap, _ = adapter.GetLiveSensorSnapshot(ctx, machine)
		sysState, _ = adapter.GetLiveSystemState(ctx, machine)
	}

	rawStatus := rawStatusFrom(status, machine.HasWaterSensor)
	result := deriveMachineState(DeriveInput{
		Status:     rawStatus,
		Now:        now,
		SensorSnap: sensorSnap,
		SysState:   sysState,
	})
	derived := result.MachineStatus
	p.runtime.SetMachineStatus(&derived)
	p.runtime.SetCurrentTemps(zeroToNil(derived.Temperature), zeroToNil(derived.TargetTemperature))

	snap := p.runtime.Get()
	if derived.Temperature > 0 && !result.IsBrewing {
		// #1498: standby readings are cold/idle — never let them into the temp
		// history or the open run's samples.
		if !snap.Standby {
			p.runtime.PushTempHistory(derived.Temperature)
			p.recordPreheatSample(now, derived.Temperature, derived.TargetTemperature)
		}
		if !snap.Standby && snap.SwitchOnAt != nil && derived.TargetTemperature > 0 &&
			derived.Temperature >= derived.TargetTemperature-2 && p.runtime.IsTempStable() {
			preheatMs := int64(loadPreheatMinutes()) * 60_000
			if now-*snap.SwitchOnAt < preheatMs {
				// Record the real stabilisation time before backdating the
				// runtime's SwitchOnAt to "preheat complete".
				p.markPreheatStable(now)
				newOnAt := now - preheatMs
				p.runtime.SetSwitchOnAt(&newOnAt)
				p.runtime.SetStabilityReady(true)
				p.savePreheatState()
				log.Printf("system: temperature stable -- preheat marked complete")
				p.hub.Publish(sse.Event{Type: sse.EventPreheatUpdate, Data: p.buildPreheatResponseFor(switchEntityOf(machine))})
			}
		}
	} else if result.IsBrewing {
		p.runtime.ClearTempHistory()
	}

	p.state.mu.Lock()
	if result.IsBrewing && p.state.liveAccum == nil {
		p.state.liveAccum = &liveAccumState{startTime: now, profileName: result.ProfileName, prevWeight: derived.Weight}
		log.Printf("system: brew started: profile %s", result.ProfileName)
		debugLogf("Brew started detail: brewSwitchState=%v sensorBrewActive=%v upTime=%d",
			rawStatus.Brewing, sensorSnap != nil && sensorSnap.BrewActive, rawStatus.UpTime)
	}
	brewJustFinished := false
	if !result.IsBrewing && p.state.liveAccum != nil {
		log.Printf("system: brew finished")
		debugLogf("Brew finished detail: brewSwitchState=%v sensorBrewActive=%v upTime=%d",
			rawStatus.Brewing, sensorSnap != nil && sensorSnap.BrewActive, rawStatus.UpTime)
		p.state.liveAccum = nil
		p.state.liveSeq++
		brewJustFinished = true
	}
	if result.IsBrewing && p.state.liveAccum != nil && !liveAccumFull(p.state.liveAccum.datapoints.TimeInShot) {
		acc := p.state.liveAccum
		elapsed := elapsedTenths(now, acc.startTime)
		weightFlow := derived.Weight - acc.prevWeight
		if weightFlow < 0 {
			weightFlow = 0
		}
		acc.prevWeight = derived.Weight
		acc.datapoints.TimeInShot = append(acc.datapoints.TimeInShot, elapsed)
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
		acc.datapoints.ShotWeight = append(acc.datapoints.ShotWeight, round10(derived.Weight))
		acc.datapoints.WeightFlow = append(acc.datapoints.WeightFlow, round10(weightFlow))
		acc.datapoints.PumpFlow = append(acc.datapoints.PumpFlow, round10(derefFloat(derived.PumpFlow)))
		acc.datapoints.TargetTemperature = append(acc.datapoints.TargetTemperature, round10(derived.TargetTemperature))
	}

	// #902: steam/flush live sessions -- same start/stop/accumulate shape
	// as the brew block above, with a simpler datapoint set
	// (timeInMode/pressure/temperature only). isBrewing/isSteaming/isFlushing
	// are NOT strictly mutually exclusive at the signal level: sensorSnap
	// .steamActive and sysState.operationMode are cached independently with
	// their own staleness windows, so a mode transition can transiently read
	// two of them true within the same tick. Guard with an explicit
	// priority instead of trusting exclusivity: brewing > steaming > flushing
	// > descaling (#983: descale added last, same lowest-priority reasoning
	// as flushing).
	effectiveSteaming := result.IsSteaming && !result.IsBrewing
	effectiveFlushing := result.IsFlushing && !result.IsBrewing && !result.IsSteaming
	effectiveDescaling := result.IsDescaling && !result.IsBrewing && !result.IsSteaming && !result.IsFlushing

	if effectiveSteaming && p.state.steamAccum == nil {
		p.state.steamAccum = &modeAccumState{startTime: now}
		log.Printf("system: steam started")
	}
	if !effectiveSteaming && p.state.steamAccum != nil {
		log.Printf("system: steam finished")
		p.state.steamAccum = nil
		p.state.steamSeq++
	}
	if effectiveSteaming && p.state.steamAccum != nil && !liveAccumFull(p.state.steamAccum.datapoints.TimeInMode) {
		acc := p.state.steamAccum
		acc.datapoints.TimeInMode = append(acc.datapoints.TimeInMode, elapsedTenths(now, acc.startTime))
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
	}

	if effectiveFlushing && p.state.flushAccum == nil {
		p.state.flushAccum = &modeAccumState{startTime: now}
		log.Printf("system: flush started")
	}
	if !effectiveFlushing && p.state.flushAccum != nil {
		log.Printf("system: flush finished")
		p.state.flushAccum = nil
		p.state.flushSeq++
	}
	if effectiveFlushing && p.state.flushAccum != nil && !liveAccumFull(p.state.flushAccum.datapoints.TimeInMode) {
		acc := p.state.flushAccum
		acc.datapoints.TimeInMode = append(acc.datapoints.TimeInMode, elapsedTenths(now, acc.startTime))
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
	}

	if effectiveDescaling && p.state.descaleAccum == nil {
		p.state.descaleAccum = &modeAccumState{startTime: now}
		log.Printf("system: descale started")
	}
	if !effectiveDescaling && p.state.descaleAccum != nil {
		log.Printf("system: descale finished")
		p.state.descaleAccum = nil
		p.state.descaleSeq++
	}
	if effectiveDescaling && p.state.descaleAccum != nil && !liveAccumFull(p.state.descaleAccum.datapoints.TimeInMode) {
		acc := p.state.descaleAccum
		acc.datapoints.TimeInMode = append(acc.datapoints.TimeInMode, elapsedTenths(now, acc.startTime))
		acc.datapoints.Pressure = append(acc.datapoints.Pressure, round10(derived.Pressure))
		acc.datapoints.Temperature = append(acc.datapoints.Temperature, round10(derived.Temperature))
	}
	p.state.mu.Unlock()

	// #953: 3s after a brew ends, pull the shot the machine just wrote.
	if brewJustFinished {
		p.scheduleSyncAfterBrew()
	}

	p.emitLiveSnapshotFor(machine.ID)
}

// switchEntityOf is defaultSwitchEntity for an already-resolved machine.
func switchEntityOf(m *machines.Machine) string {
	if m == nil || m.SwitchEntity == nil {
		return ""
	}
	return *m.SwitchEntity
}

func round10(v float64) int { return int(v*10 + 0.5) }

// elapsedTenths rounds to tenths-of-a-second precision for timeInShot
// datapoints. It uses math.Round rather than a bare `int(x/100)` truncation:
// truncation toward zero would produce a systematic off-by-one offset against
// shots already recorded with rounded values sharing the same DB (#901 code
// review: 950ms elapsed rounds to 10, truncates to 9).
func elapsedTenths(now, startTime int64) int {
	return int(math.Round(float64(now-startTime) / 100))
}

// liveAccumFull reports whether a live accumulator's per-tick time series has
// reached maxLiveAccumPoints. The poll loop skips the append once it has, so a
// machine stuck in a mode can't grow the series (and the per-tick copy and
// broadcast of it) without bound. Every series of one accumulator is appended
// together, so testing any one of them bounds them all.
func liveAccumFull(series []int) bool {
	return len(series) >= maxLiveAccumPoints
}

func zeroToNil(v float64) *float64 {
	if v == 0 {
		return nil
	}
	return &v
}

// statusObject returns the first element when the machine's status body is a
// JSON array (current Gaggiuino firmware), else the body itself so GaggiMate's
// object payload keeps working. An empty array falls through to the raw body,
// which then decodes to no fields.
func statusObject(raw json.RawMessage) json.RawMessage {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
		return arr[0]
	}
	return raw
}

// rawStatusFrom decodes the two fields machines.Status doesn't already
// carry (waterLevel/upTime) straight off its Raw JSON — the rest come from
// Status's own already-parsed fields. Current Gaggiuino firmware reports its
// status as a one-element JSON array whose values are strings, so the body is
// unwrapped before decoding and each field is read tolerantly (#1149).
// hasWaterSensor gates the GaggiMate-specific `wl` field: GaggiMate always
// sends wl=100 when no ALBA sensor is present, so we only read it when the user
// has explicitly flagged the machine as having one. Gaggiuino sends
// `waterLevel` (not `wl`) and has no such ambiguity, so that field is read
// unconditionally as a fallback.
func rawStatusFrom(s machines.Status, hasWaterSensor bool) RawStatus {
	var m map[string]any
	_ = json.Unmarshal(statusObject(s.Raw), &m)

	intField := func(key string) *int {
		v, ok := jsNumberToInt64(m[key])
		if !ok || v < math.MinInt32 || v > math.MaxInt32 {
			return nil
		}
		n := int(v)
		return &n
	}

	var waterLevel *int
	if hasWaterSensor {
		waterLevel = intField("wl")
	}
	if waterLevel == nil {
		waterLevel = intField("waterLevel")
	}

	upTime := 0
	if v := intField("upTime"); v != nil {
		upTime = *v
	}

	var steamOn bool
	if s.SteamOn != nil {
		steamOn = *s.SteamOn
	}
	return RawStatus{
		WaterLevel:        waterLevel,
		UpTime:            upTime,
		Brewing:           s.Brewing,
		FlushActive:       s.Flushing,
		Temperature:       s.Temperature,
		TargetTemperature: s.TargetTemperature,
		Pressure:          s.Pressure,
		Weight:            derefFloat(s.Weight),
		PumpFlow:          s.PumpFlow,
		ProfileID:         s.ProfileID,
		ProfileName:       s.ProfileName,
		SteamSwitchState:  steamOn,
		Warnings:          activeMachineWarnings(m["warn"]),
		UpdateAvailable:   m["up"] == true,
	}
}

// activeMachineWarnings extracts the active warning keys from a GaggiMate
// evt:status `warn` array. GaggiMate WebSocketHandler.cpp's addWarnings
// emits one {k, l, a} entry per WarningManager warning: k is the key, l its
// level (0 ignore / 1 warn / 2 error) and a whether it is currently active.
// Keep only entries that are active (a == true) and at least warn-level
// (l >= 1), preserving the firmware's order. A non-array value yields nil.
func activeMachineWarnings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, e := range arr {
		entry, ok := e.(map[string]any)
		if !ok {
			continue
		}
		k, ok := entry["k"].(string)
		if !ok || k == "" {
			continue
		}
		a, _ := entry["a"].(bool)
		l, _ := entry["l"].(float64)
		if a && l >= 1 {
			out = append(out, k)
		}
	}
	return out
}

func derefFloat(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// extractVersion reads the machine's firmware version from the first present
// of softwareVersion/version/firmware/buildNumber/fw_version/buildDate.
func extractVersion(raw json.RawMessage) string {
	var obj struct {
		SoftwareVersion any `json:"softwareVersion"`
		Version         any `json:"version"`
		Firmware        any `json:"firmware"`
		BuildNumber     any `json:"buildNumber"`
		FwVersion       any `json:"fw_version"`
		BuildDate       any `json:"buildDate"`
	}
	if err := json.Unmarshal(statusObject(raw), &obj); err != nil {
		return ""
	}
	for _, v := range []any{obj.SoftwareVersion, obj.Version, obj.Firmware, obj.BuildNumber, obj.FwVersion, obj.BuildDate} {
		if s := anyToString(v); s != "" {
			return s
		}
	}
	return ""
}

func anyToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return ""
	}
}

// redactURLs replaces any URL in an error message with "[url]" --
// lastMachineError must never leak the configured machine host to a client.
func redactURLs(msg string) string {
	for {
		idx := strings.Index(msg, "http://")
		if idx == -1 {
			idx = strings.Index(msg, "https://")
		}
		if idx == -1 {
			return msg
		}
		end := idx
		for end < len(msg) && msg[end] != ' ' && msg[end] != '\t' && msg[end] != '\n' {
			end++
		}
		msg = msg[:idx] + "[url]" + msg[end:]
	}
}
