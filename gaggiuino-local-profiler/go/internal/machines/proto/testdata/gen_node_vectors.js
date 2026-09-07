// Generates internal/machines/proto/testdata/node_vectors.json — ground-
// truth {hex, decoded} pairs produced by driving lib/gaggiuino-proto.js's
// real @protobuf-ts/runtime-backed encoder/decoder (the same code this app
// depends on in production, not a reimplementation) against a set of
// representative instances of every message type this repo's Go port
// (internal/machines/proto) implements.
//
// Deliberately includes an all-zero-valued instance of the biggest message
// (SensorStateSnapshotDto) alongside populated ones: proto3 omits
// default-valued scalar fields from the wire, so the zero-value case is
// the one most likely to hide a Go encoder/decoder bug that a
// fields-always-populated fixture would never exercise.
//
// Regenerate with: node internal/machines/proto/testdata/gen_node_vectors.js
// (run from the repo's Node root — needs @protobuf-ts/runtime, already an
// app dependency). internal/machines/proto/node_vectors_test.go consumes
// the output; see proto/doc.go for how the two directions of the
// cross-check work.
'use strict';
const fs = require('fs');
const path = require('path');
const proto = require('../../../../../lib/gaggiuino-proto');

const vectors = [];

function addVector(name, msgType, value) {
    const msg = msgType.create(value);
    const bytes = msgType.toBinary(msg);
    const decoded = JSON.parse(JSON.stringify(msgType.fromBinary(bytes)));
    // Uint8Array (the `data` bytes field, WebSocketMessageDto only) has no
    // custom toJSON — plain JSON.stringify serializes it as an index-keyed
    // object ({"0":222,"1":173,...}), which has no clean Go equivalent to
    // compare against. Normalize to a hex string instead, purely for this
    // fixture's cross-language comparison — encoding/decoding itself still
    // exercises the real bytes field either way.
    if (decoded.data && typeof decoded.data === 'object') {
        const byteValues = Object.keys(decoded.data).sort((a, b) => Number(a) - Number(b)).map(k => decoded.data[k]);
        decoded.data = Buffer.from(byteValues).toString('hex');
    }
    vectors.push({ name, hex: Buffer.from(bytes).toString('hex'), decoded });
}

// ── PhaseStopConditionsDto ──────────────────────────────────────────────
addVector('PhaseStopConditionsDto/zero', proto.PhaseStopConditionsDto, {});
addVector('PhaseStopConditionsDto/populated', proto.PhaseStopConditionsDto, {
    time: 3000, pressureAbove: 6.5, pressureBelow: 1.2, flowAbove: 2.5, flowBelow: 0.5,
    weight: 36, waterPumpedInPhase: 40.25,
});

// ── TransitionDto ────────────────────────────────────────────────────────
addVector('TransitionDto/populated', proto.TransitionDto, {
    start: 1.5, end: 9, curve: proto.TransitionCurveDto.LINEAR, time: 5000, volume: 0,
});
addVector('TransitionDto/instant', proto.TransitionDto, {
    start: 0, end: 0, curve: proto.TransitionCurveDto.INSTANT, time: 0, volume: 12.3,
});

// ── PhaseDto ─────────────────────────────────────────────────────────────
addVector('PhaseDto/full', proto.PhaseDto, {
    type: proto.PhaseTypeDto.PRESSURE,
    target: { start: 1.5, end: 9, curve: proto.TransitionCurveDto.LINEAR, time: 5000, volume: 0 },
    restriction: 40,
    stopConditions: { time: 3000, weight: 36 },
    waterTemperature: 93.7,
    name: 'Preinfusion',
    skip: false,
});
addVector('PhaseDto/minimal-no-optionals', proto.PhaseDto, {
    type: proto.PhaseTypeDto.FLOW,
});
addVector('PhaseDto/skip-true', proto.PhaseDto, {
    type: proto.PhaseTypeDto.MANUAL,
    skip: true,
});

// ── GlobalStopConditionsDto / BrewRecipeDto ─────────────────────────────
addVector('GlobalStopConditionsDto/populated', proto.GlobalStopConditionsDto, {
    time: 30000, weight: 40, waterPumped: 45.5,
    switchToManualPressureCtrl: true, switchToManuaFlowCtrl: false,
});
addVector('BrewRecipeDto/populated', proto.BrewRecipeDto, { coffeeIn: 18, coffeeOut: 36, ratio: 2 });

// ── ProfileDto ───────────────────────────────────────────────────────────
addVector('ProfileDto/full', proto.ProfileDto, {
    id: 5,
    name: 'Test Profile',
    phases: [
        {
            type: proto.PhaseTypeDto.PRESSURE,
            target: { start: 1.5, end: 9, curve: proto.TransitionCurveDto.LINEAR, time: 5000 },
            stopConditions: { time: 3000 },
            waterTemperature: 93.5,
            name: 'p1',
        },
        {
            type: proto.PhaseTypeDto.FLOW,
            target: { start: 2, end: 2, curve: proto.TransitionCurveDto.INSTANT, time: 25000 },
            stopConditions: { weight: 36 },
            waterTemperature: 92,
            name: 'p2',
            skip: true,
        },
    ],
    globalStopConditions: { weight: 40, switchToManualPressureCtrl: true },
    waterTemperature: 93,
    recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
});
addVector('ProfileDto/no-optionals', proto.ProfileDto, {
    name: 'NoOptionals',
    phases: [{ type: proto.PhaseTypeDto.FLOW }],
});

// ── Envelope + saved-profile-list ───────────────────────────────────────
addVector('WebSocketProfileIdCommandDto/populated', proto.WebSocketProfileIdCommandDto, { id: 42 });

addVector('WebSocketMessageDto/with-data', proto.WebSocketMessageDto, {
    action: 'g_prof_dict',
    data: Uint8Array.from(Buffer.from('deadbeef', 'hex')),
});
addVector('WebSocketMessageDto/action-only', proto.WebSocketMessageDto, { action: 'g_sys_state' });

addVector('WebSocketResponseDto/success', proto.WebSocketResponseDto, {
    action: 'c_opmode', result: proto.WebSocketResponseResultDto.SUCCESS,
});
addVector('WebSocketResponseDto/error', proto.WebSocketResponseDto, {
    action: 'c_tare_pend', result: proto.WebSocketResponseResultDto.ERROR, errorMessage: 'busy',
});

addVector('SavedProfileDto/populated', proto.SavedProfileDto, { id: 7, name: 'Espresso' });

addVector('SavedProfilesDto/multiple', proto.SavedProfilesDto, {
    profiles: [{ id: 1, name: 'Espresso' }, { id: 2, name: 'Lungo' }],
});
addVector('SavedProfilesDto/empty', proto.SavedProfilesDto, { profiles: [] });

addVector('NotificationDto/service-test-complete', proto.NotificationDto, {
    type: proto.NotificationTypeDto.SUCCESS, message: 'Service test complete',
});

// ── #597 command/state messages ─────────────────────────────────────────
addVector('UpdateSystemStateCommandDto/opmode', proto.UpdateSystemStateCommandDto, {
    operationMode: proto.OperationModeDto.STEAM, tarePending: false,
});
addVector('UpdateSystemStateCommandDto/tare', proto.UpdateSystemStateCommandDto, {
    operationMode: proto.OperationModeDto.BREW_AUTO, tarePending: true,
});

addVector('ServiceTestCommandDto/led', proto.ServiceTestCommandDto, {
    peripheral: proto.ServiceTestPeripheralDto.LED,
});

addVector('SensorStateSnapshotDto/zero', proto.SensorStateSnapshotDto, {});
addVector('SensorStateSnapshotDto/populated', proto.SensorStateSnapshotDto, {
    brewActive: true, steamActive: false, hotWaterSwitchState: false,
    temperature: 93.7, waterTemperature: 21.4, pressure: 9.2, pumpFlow: 2.1, weightFlow: 1.9,
    weight: 18.4, waterLevel: 80, boilerState: true, brewSwitchActive: true,
    valveState: true, steamValveState: false, valveBState: false, steamBoilerRelayState: false,
    pinBrewLevel: true, pinSteamLevel: false, pinWaterLevel: true, pinRelayLevel: true,
    pinValveLevel: false, pinValveBLevel: false, pinRelayValveBLevel: false,
    pinSteamValveRelayLevel: false, pinSteamBoilerRelayLevel: false, pinZcLevel: true,
    pinDimmerLevel: true, pinThermoCsLevel: false, pinThermoClkLevel: false,
    pinThermoDoLevel: false, pinThermoDiLevel: false, pinHx711SckLevel: true,
    pinHx711Dout1Level: true, pinHx711Dout2Level: false,
});

addVector('SystemStateDto/populated', proto.SystemStateDto, {
    startupInitFinished: true, tofReady: true, isSteamForgottenON: false, scalesPresent: true,
    operationMode: proto.OperationModeDto.BREW_AUTO, timeAlive: 123456,
    coreVersion: '7889b7d', tarePending: false, coreType: 'STM32',
    thermocoupleFaulted: false, pressureSensorFaulted: false,
    thermocoupleFaultReason: '', pressureSensorFaultReason: '', pcbV2: true,
});
addVector('SystemStateDto/zero', proto.SystemStateDto, {});

const outPath = path.join(__dirname, 'node_vectors.json');
fs.writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n');
console.log(`Wrote ${vectors.length} vectors to ${outPath}`);
