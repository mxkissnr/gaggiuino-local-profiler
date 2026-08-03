// #598: dispatch seam deciding, per read, whether the live-state cache
// (sensorSnap/sysState) is served from lib/gaggiuino-live-client.js's
// persistent WS session or lib/gaggiuino-mqtt-client.js's MQTT subscription
// — both populate/read identically-shaped caches (see gaggiuino-mqtt-
// client.js's toSensorSnap()/toSysState() comments), so callers
// (lib/poll.js, lib/machines/gaggiuino/adapter.js -> routes/machine-
// control.js's GET /api/machine/live) stay unaware of which transport is
// active. This is the whole point of #597's event/cache seam this issue
// builds on.
//
// MQTT settings (lib/repositories/MqttSettingsRepository.js) are a single
// global broker connection, not per-machine, mirroring the add-on's single
// Settings-page toggle ("Live connection: WebSocket / MQTT"). Only the
// default machine (registry id 1 — the classic single-machine case this
// add-on was built around) is eligible for MQTT; any additional configured
// machine (#317) always stays on its own baseUrl-keyed WS session regardless
// of the toggle, since the MQTT prefix/broker is scoped to one physical
// unit and silently redirecting a second machine's live data at the same
// broker/prefix would be wrong far more often than right.
'use strict';
const { log } = require('./helpers');
const gaggiuinoLive = require('./gaggiuino-live-client');
const gaggiuinoMqtt = require('./gaggiuino-mqtt-client');
const mqttSettingsRepo = require('./repositories/MqttSettingsRepository');

// #611: logs once when the effective transport for the default machine's
// live-data read actually changes (not on every read — this is called from
// every poll cycle) so it's possible to confirm from the logs alone which
// transport is active after flipping the Settings toggle, without reading
// source code or attaching a debugger.
let lastLoggedTransport = null;
function logTransportChange(active) {
    if (active === lastLoggedTransport) return;
    lastLoggedTransport = active;
    log(`Live-data transport for the default machine is now: ${active}`);
}

function mqttEligible(isDefaultMachine) {
    if (!isDefaultMachine) return false;
    const settings = mqttSettingsRepo.getSettings();
    return settings.transport === 'mqtt' && !!settings.host;
}

function getLiveSensorSnapshot(baseUrl, isDefaultMachine = true) {
    const useMqtt = mqttEligible(isDefaultMachine);
    if (isDefaultMachine) logTransportChange(useMqtt ? 'MQTT' : 'WebSocket');
    if (useMqtt) return gaggiuinoMqtt.getLiveSensorSnapshot(mqttSettingsRepo.getSettings());
    return gaggiuinoLive.getLiveSensorSnapshot(baseUrl);
}

function getLiveSystemState(baseUrl, isDefaultMachine = true) {
    if (mqttEligible(isDefaultMachine)) return gaggiuinoMqtt.getLiveSystemState(mqttSettingsRepo.getSettings());
    return gaggiuinoLive.getLiveSystemState(baseUrl);
}

module.exports = { getLiveSensorSnapshot, getLiveSystemState };
