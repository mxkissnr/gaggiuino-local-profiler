'use strict';
// #552: the two pure decisions lib/poll.js used to make inline —
// parsing/normalizing a raw /api/system/status payload (including brew
// detection) and the warm/cold heuristic for whether a resumed live-polling
// session should be treated as still warm. Both take plain values/snapshots
// and return plain values — no axios, no lib/state, no lib/machine-runtime-state
// — so they're unit-testable without mocking I/O or global state.
const { WARM_TEMP_MIN, WARM_OFF_MAX_MS } = require('./constants');

// Normalizes one /api/system/status payload (already unwrapped from the
// array some firmware versions wrap it in) into the values
// pollViaGaggiuinoStatus() needs, plus the isBrewing decision.
//
// `live` (#597) is optional and additive: { sensorSnap, sysState }, the
// cached WS pushes from lib/gaggiuino-live-client.js's getLiveSensorSnapshot/
// getLiveSystemState (decoded SensorStateSnapshotDto/SystemStateDto, or
// null if nothing has arrived yet). Neither REST /api/system/status nor
// this function fetches them — callers pass in whatever's already cached,
// keeping this function pure. Omitting `live` entirely (every existing
// caller/test) reproduces the exact prior machineStatus shape.
function deriveMachineState(status, now = Date.now(), live = {}) {
    const isBrewing         = !!status.brewSwitchState;
    const pressure          = parseFloat(status.pressure)          || 0;
    const temperature       = parseFloat(status.temperature)       || 0;
    const weight            = parseFloat(status.weight)            || 0;
    const targetTemperature = parseFloat(status.targetTemperature) || 0;
    const profileName       = status.profileName || 'Unknown';

    const machineStatus = {
        temperature,
        targetTemperature,
        pressure,
        waterLevel:       parseInt(status.waterLevel) || 0,
        weight,
        upTime:            parseInt(status.upTime)    || 0,
        profileId:         parseInt(status.profileId) || null,
        profileName:       status.profileName         || null,
        brewSwitchState:   isBrewing,
        steamSwitchState:  !!status.steamSwitchState,
        updatedAt:         now,
    };

    const { sensorSnap, sysState } = live;
    if (sensorSnap) {
        machineStatus.pumpFlow              = sensorSnap.pumpFlow    || 0;
        machineStatus.weightFlow            = sensorSnap.weightFlow  || 0;
        machineStatus.waterTemperature      = sensorSnap.waterTemperature || 0;
        machineStatus.boilerState           = !!sensorSnap.boilerState;
        machineStatus.valveState            = !!sensorSnap.valveState;
        machineStatus.steamValveState       = !!sensorSnap.steamValveState;
        machineStatus.valveBState           = !!sensorSnap.valveBState;
        machineStatus.steamBoilerRelayState = !!sensorSnap.steamBoilerRelayState;
    }
    if (sysState) {
        machineStatus.thermocoupleFaulted         = !!sysState.thermocoupleFaulted;
        machineStatus.thermocoupleFaultReason     = sysState.thermocoupleFaultReason || '';
        machineStatus.pressureSensorFaulted       = !!sysState.pressureSensorFaulted;
        machineStatus.pressureSensorFaultReason   = sysState.pressureSensorFaultReason || '';
    }

    return { isBrewing, pressure, temperature, weight, targetTemperature, profileName, machineStatus };
}

// Warm/cold heuristic: whether a machine that was polling before should be
// treated as still warm when live polling (re)starts — pure over a
// MachineRuntimeState snapshot ({ switchOffAt, currentTemp, switchOnAt })
// and the current time.
function isStillWarm(runtime, now = Date.now()) {
    const offMs   = runtime.switchOffAt ? now - runtime.switchOffAt : 0;
    const coldOff = offMs >= WARM_OFF_MAX_MS;
    return runtime.currentTemp !== null
        ? (runtime.currentTemp > WARM_TEMP_MIN && !coldOff)
        : (runtime.switchOnAt !== null && !coldOff);
}

module.exports = { deriveMachineState, isStillWarm };
