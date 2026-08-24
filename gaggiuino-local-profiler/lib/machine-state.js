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
    // #615/#902: brew-start detection (and the physical-switch-on half of
    // stop detection) stays anchored on brewSwitchState read from REST, not
    // sensorSnap.brewSwitchActive -- the MQTT transport's toSensorSnap()
    // (gaggiuino-mqtt-client.js) only ever maps brewActive, never
    // brewSwitchActive, so the two live transports would disagree on which
    // field means "the physical switch is on" if this read off sensorSnap
    // instead. brewSwitchState is the one switch-state signal REST and both
    // transports agree on unambiguously, and it's arguably still the more
    // authoritative source (the physical switch) regardless.
    //
    // #902: under BREW_AUTO, the firmware auto-stops the brew once its
    // target weight/time is hit, but the physical switch itself stays up
    // until the user manually flips it back down -- so brewSwitchState alone
    // kept the live timer running well after the shot was actually over.
    // sensorSnap.brewActive (unlike .brewSwitchActive above) IS mapped
    // identically by both live transports (gaggiuino-proto.js's WS decode
    // and gaggiuino-mqtt-client.js's toSensorSnap(), both under the same
    // `brewActive` name) and means "firmware is actively brewing right now"
    // -- so once a live transport is connected and it flips to false, that's
    // trusted immediately even while the switch is still up. `brewActive` is
    // a plain scalar bool in the protobuf schema (gaggiuino-proto.js), not a
    // field with presence tracking, so protobuf-ts always fills it with a
    // real boolean (defaulting false) and the MQTT mapper does `!!p.brewActive`
    // -- it's never actually undefined except via sensorSnap itself being
    // null, which the `?.` below already covers. `!== false` (rather than a
    // plain truthiness check) is therefore defensive/clarity only, not a
    // guard against a real undefined-from-transport case. No live transport
    // connected at all (sensorSnap null) reproduces the pre-#902 REST-only
    // behaviour exactly, unchanged.
    const { sensorSnap, sysState } = live;
    const isBrewing = !!status.brewSwitchState && sensorSnap?.brewActive !== false;

    // #615: sensorSnap (WS or MQTT, via lib/live-transport.js) is only ever
    // passed non-null when fresh -- see the STALE_MS checks in
    // gaggiuino-live-client.js's/gaggiuino-mqtt-client.js's
    // getLiveSensorSnapshot() -- so preferring its temperature/pressure/
    // weight here is strictly fresher data than the REST poll, never a
    // stale-but-served fallback. targetTemperature stays REST/profile-
    // sourced below -- it's a configured setpoint, not a live sensor
    // reading, and neither SensorStateSnapshotDto nor SystemStateDto
    // (lib/gaggiuino-proto.js) carries an equivalent field to source it from.
    const pressure          = sensorSnap ? (parseFloat(sensorSnap.pressure)    || 0) : (parseFloat(status.pressure)    || 0);
    const temperature       = sensorSnap ? (parseFloat(sensorSnap.temperature) || 0) : (parseFloat(status.temperature) || 0);
    const weight             = sensorSnap ? (parseFloat(sensorSnap.weight)     || 0) : (parseFloat(status.weight)     || 0);
    // #698: only sensorSnap (WS/MQTT live transport) carries a flow reading —
    // REST /api/system/status has no equivalent field, so this is 0 whenever
    // no live transport is connected, same as before this field existed.
    const pumpFlow           = sensorSnap ? (parseFloat(sensorSnap.pumpFlow)   || 0) : 0;
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

    if (sensorSnap) {
        machineStatus.pumpFlow              = pumpFlow;
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

    return { isBrewing, pressure, temperature, weight, pumpFlow, targetTemperature, profileName, machineStatus };
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
