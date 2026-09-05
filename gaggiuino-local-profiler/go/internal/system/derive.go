package system

import (
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// This file ports lib/machine-state.js: the two pure decisions
// pollViaGaggiuinoStatus() makes inline in Node — normalizing one raw
// /api/system/status poll (plus whatever's cached from the live WS
// transport) into machineStatus/brew-detection, and the warm/cold
// heuristic for whether a resumed live-polling session should be treated
// as still warm. Both are pure over plain values, same as the Node
// original, so they're unit-testable without a fake HTTP server or a
// RuntimeState.

// MachineStatus mirrors the exact JSON shape GET /api/machine/status
// returns and Node's machineStatus object literal in
// lib/machine-state.js's deriveMachineState() builds — field names are a
// binding contract for glp-integration's machine_coordinator.py (polls
// this every 5s) and glp-lovelace-card/glp-order-card. The eight
// SensorSnap-sourced fields and four SysState-sourced fields are pointers
// specifically so they're omitted from the JSON entirely when no live WS
// session has pushed data yet — exactly matching Node only ever assigning
// them onto machineStatus inside `if (sensorSnap) {...}`/`if (sysState) {...}`
// blocks, never unconditionally.
type MachineStatus struct {
	Temperature       float64 `json:"temperature"`
	TargetTemperature float64 `json:"targetTemperature"`
	Pressure          float64 `json:"pressure"`
	WaterLevel        *int    `json:"waterLevel"`
	Weight            float64 `json:"weight"`
	UpTime            int     `json:"upTime"`
	ProfileID         *int    `json:"profileId"`
	ProfileName       *string `json:"profileName"`
	BrewSwitchState   bool    `json:"brewSwitchState"`
	SteamSwitchState  bool    `json:"steamSwitchState"`
	// #902: steam/flush live states. isSteaming mirrors brewSwitchState's
	// own sensorSnap-preferred/REST-fallback pattern; isFlushing/opMode
	// have no REST equivalent (the operation-mode enum is only ever pushed
	// via WS/MQTT sysState) and stay false/nil whenever no live transport
	// is connected. opMode is the canonical wire-enum name or nil, matching
	// Node's `opMode` (string name or null), always present in the JSON.
	IsSteaming bool `json:"isSteaming"`
	IsFlushing bool `json:"isFlushing"`
	// #983: descale mirrors isFlushing's opMode-only derivation (no REST
	// equivalent, stays false/nil whenever no live transport is connected).
	IsDescaling bool    `json:"isDescaling"`
	OpMode      *string `json:"opMode"`
	UpdatedAt   int64   `json:"updatedAt"`

	PumpFlow              *float64 `json:"pumpFlow,omitempty"`
	WeightFlow            *float64 `json:"weightFlow,omitempty"`
	WaterTemperature      *float64 `json:"waterTemperature,omitempty"`
	BoilerState           *bool    `json:"boilerState,omitempty"`
	ValveState            *bool    `json:"valveState,omitempty"`
	SteamValveState       *bool    `json:"steamValveState,omitempty"`
	ValveBState           *bool    `json:"valveBState,omitempty"`
	SteamBoilerRelayState *bool    `json:"steamBoilerRelayState,omitempty"`

	ThermocoupleFaulted       *bool   `json:"thermocoupleFaulted,omitempty"`
	ThermocoupleFaultReason   *string `json:"thermocoupleFaultReason,omitempty"`
	PressureSensorFaulted     *bool   `json:"pressureSensorFaulted,omitempty"`
	PressureSensorFaultReason *string `json:"pressureSensorFaultReason,omitempty"`
}

// RawStatus is the subset of a raw /api/system/status poll's fields
// machines.Status doesn't already carry (that struct is shared with the
// settings/control proxy's reachability probe and doesn't need
// waterLevel/upTime), decoded straight off machines.Status.Raw by poll.go.
type RawStatus struct {
	WaterLevel        *int
	UpTime            int
	Brewing           bool
	Temperature       float64
	TargetTemperature float64
	Pressure          float64
	Weight            float64
	PumpFlow          *float64
	ProfileID         *int
	ProfileName       *string
	SteamSwitchState  bool
}

// DeriveInput bundles one poll tick's raw REST status plus whatever's
// currently cached from the live WS transport (nil/nil on a machine with
// no session yet, or one that's (re)connecting) — deriveMachineState's
// `status`/`live` parameters.
type DeriveInput struct {
	Status     RawStatus
	Now        int64 // epoch ms
	SensorSnap *proto.SensorStateSnapshotDto
	SysState   *proto.SystemStateDto
}

// DeriveResult mirrors deriveMachineState()'s return shape. #901 code
// review: Pressure/Temperature/Weight/TargetTemperature/PumpFlow used to
// also live here as flat fields, duplicating the exact same
// poll-tick-sourced values MachineStatus already carries (ms.Pressure :=
// pressure, etc., below) — two representations of one value with nothing
// enforcing they stay in sync. DeriveResult is never JSON-marshaled itself
// (only MachineStatus is, via machineStatusResponse), so there's no API
// compatibility reason to keep the duplicates; poll.go's
// pollViaGaggiuinoStatus now reads result.MachineStatus.* directly instead.
// IsBrewing/ProfileName stay flat: IsBrewing does equal
// MachineStatus.BrewSwitchState (same reasoning would apply), but
// ProfileName does NOT — it's the "Unknown"-defaulted display value poll.go
// needs for liveAccumState/logging, while MachineStatus.ProfileName is the
// nil-on-empty JSON field, a genuinely different representation, not a
// duplicate.
type DeriveResult struct {
	IsBrewing     bool
	IsSteaming    bool
	IsFlushing    bool
	IsDescaling   bool
	ProfileName   string
	MachineStatus MachineStatus
}

// deriveMachineState ports lib/machine-state.js's deriveMachineState(status,
// now, live) field-for-field — see that file's own comments for why
// brewing detection stays REST-sourced (status.Brewing) even when a live
// WS sample is available, and why targetTemperature never reads off the
// live transport either.
func deriveMachineState(in DeriveInput) DeriveResult {
	// #902: brew-start detection stays anchored on the REST brewSwitchState,
	// but once a live transport is connected, sensorSnap.brewActive flipping
	// false (a BREW_AUTO firmware auto-stop, switch still physically up)
	// ends the live brew immediately. sensorSnap.brewActive is mapped
	// identically by both live transports, unlike .brewSwitchActive. No live
	// transport (SensorSnap nil) reproduces the prior REST-only behavior.
	isBrewing := in.Status.Brewing
	if in.SensorSnap != nil && !in.SensorSnap.BrewActive {
		isBrewing = false
	}

	// #902: steam mirrors isBrewing's sensorSnap-preferred/REST-fallback
	// pattern. opMode/isFlushing have no REST equivalent and stay nil/false
	// whenever no live transport is connected.
	isSteaming := in.Status.SteamSwitchState
	if in.SensorSnap != nil {
		isSteaming = in.SensorSnap.SteamActive
	}
	var opMode *string
	if in.SysState != nil {
		if name := proto.NormalizeOperationMode(in.SysState.OperationMode); name != "" {
			opMode = &name
		}
	}
	isFlushing := opMode != nil && (*opMode == "FLUSH" || *opMode == "FLUSH_AUTO")
	// #983: descale operation mode, same opMode-only derivation as isFlushing.
	isDescaling := opMode != nil && *opMode == "DESCALE"

	pressure := in.Status.Pressure
	temperature := in.Status.Temperature
	weight := in.Status.Weight
	var pumpFlow float64
	if in.SensorSnap != nil {
		pressure = in.SensorSnap.Pressure
		temperature = in.SensorSnap.Temperature
		weight = in.SensorSnap.Weight
		pumpFlow = in.SensorSnap.PumpFlow
	} else if in.Status.PumpFlow != nil {
		pumpFlow = *in.Status.PumpFlow
	}
	targetTemperature := in.Status.TargetTemperature
	profileName := "Unknown"
	if in.Status.ProfileName != nil && *in.Status.ProfileName != "" {
		profileName = *in.Status.ProfileName
	}

	ms := MachineStatus{
		Temperature:       temperature,
		TargetTemperature: targetTemperature,
		Pressure:          pressure,
		WaterLevel:        in.Status.WaterLevel,
		Weight:            weight,
		UpTime:            in.Status.UpTime,
		ProfileID:         in.Status.ProfileID,
		ProfileName:       nonEmptyOrNil(in.Status.ProfileName),
		BrewSwitchState:   isBrewing,
		SteamSwitchState:  in.Status.SteamSwitchState,
		IsSteaming:        isSteaming,
		IsFlushing:        isFlushing,
		IsDescaling:       isDescaling,
		OpMode:            opMode,
		UpdatedAt:         in.Now,
	}

	if in.Status.PumpFlow != nil && in.SensorSnap == nil {
		ms.PumpFlow = &pumpFlow
	}
	if in.SensorSnap != nil {
		s := in.SensorSnap
		ms.PumpFlow = &pumpFlow
		weightFlow := s.WeightFlow
		ms.WeightFlow = &weightFlow
		waterTemp := s.WaterTemperature
		ms.WaterTemperature = &waterTemp
		ms.BoilerState = &s.BoilerState
		ms.ValveState = &s.ValveState
		ms.SteamValveState = &s.SteamValveState
		ms.ValveBState = &s.ValveBState
		ms.SteamBoilerRelayState = &s.SteamBoilerRelayState
	}
	if in.SysState != nil {
		s := in.SysState
		ms.ThermocoupleFaulted = &s.ThermocoupleFaulted
		reason := s.ThermocoupleFaultReason
		ms.ThermocoupleFaultReason = &reason
		ms.PressureSensorFaulted = &s.PressureSensorFaulted
		presReason := s.PressureSensorFaultReason
		ms.PressureSensorFaultReason = &presReason
	}

	return DeriveResult{
		IsBrewing:     isBrewing,
		IsSteaming:    isSteaming,
		IsFlushing:    isFlushing,
		IsDescaling:   isDescaling,
		ProfileName:   profileName,
		MachineStatus: ms,
	}
}

func nonEmptyOrNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// isStillWarm ports lib/machine-state.js's isStillWarm(runtime, now): pure
// over the three fields it actually reads (currentTemp, switchOnAt,
// switchOffAt) rather than a whole RuntimeState, so RuntimeState.IsStillWarm
// can call it while already holding its own lock.
func isStillWarm(currentTemp *float64, switchOnAt, switchOffAt *int64, nowMs int64) bool {
	var offMs int64
	if switchOffAt != nil {
		offMs = nowMs - *switchOffAt
	}
	coldOff := offMs >= warmOffMaxDur.Milliseconds()
	if currentTemp != nil {
		return *currentTemp > warmTempMin && !coldOff
	}
	return switchOnAt != nil && !coldOff
}
