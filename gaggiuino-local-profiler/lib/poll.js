'use strict';
const axios = require('axios');
const { TEMP_HISTORY_MAX } = require('./constants');
const { log } = require('./helpers');
const { loadOptions, getMachineBaseUrl } = require('./data');
const { getSwitchState, HA_TOKEN } = require('./ha');
const state = require('./state');
const { getMachineRuntimeState } = require('./machine-runtime-state');
const { deriveMachineState, isStillWarm } = require('./machine-state');
const liveTransport = require('./live-transport');
const { savePreheatState, isTempStable } = require('./preheat');
const { syncAfterBrew, syncShots, fetchMachineVersion } = require('./sync');

// #549: this module is hard single-machine (always the default/legacy
// machine, id 1) — one runtime instance obtained once at module load,
// same lifetime as the old lib/state.js singleton it replaces for these
// fields. Functions below still accept it as a parameter so callers (and
// tests) can pass a different instance instead of relying on this default.
const defaultRuntime = getMachineRuntimeState();

function startLivePolling(runtime = defaultRuntime) {
    if (runtime.livePollTimer) return;
    if (!runtime.switchOnAt || !isStillWarm(runtime)) { runtime.switchOnAt = Date.now(); savePreheatState(runtime); }
    runtime.tempHistory = [];
    log('Live polling started via /api/system/status');
    runtime.livePollTimer = setInterval(() => pollLive(runtime), 1000);
}

function stopLivePolling(runtime = defaultRuntime) {
    if (!runtime.livePollTimer) return;
    clearInterval(runtime.livePollTimer);
    runtime.livePollTimer  = null;
    state.liveAccum        = null;
    runtime.switchOffAt    = Date.now();
    runtime.stabilityReady = false;
    runtime.tempHistory    = [];
    savePreheatState(runtime);
    log('Live polling stopped');
}

async function pollLive(runtime = defaultRuntime) {
    if (state.isPollRunning) return;
    state.isPollRunning = true;
    try { await pollViaGaggiuinoStatus(runtime); }
    // eslint-disable-next-line require-atomic-updates -- this is the mutex-release for the guard checked at the top of this function; only this function ever writes it
    finally { state.isPollRunning = false; }
}

async function pollViaGaggiuinoStatus(runtime = defaultRuntime) {
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const statusRes = await axios.get(`${baseUrl}/api/system/status`, { timeout: 3000 });
        state.machineReachable   = true;
        state.lastMachineError   = null;
        state.lastMachineSuccess = Date.now();
        const raw       = statusRes.data;
        const status    = Array.isArray(raw) ? raw[0] : raw;

        // #597/#598: best-effort merge of whatever's already cached from
        // the active live-data transport (lib/live-transport.js dispatches
        // to either the persistent WS session or the MQTT subscription) — a
        // synchronous cache read, never awaited/fetched here, so a machine
        // with no session yet (or one that's still (re)connecting) just
        // gets deriveMachineState()'s pre-#597 fields, same as before. This
        // module is hard single-machine (always the default machine, see
        // the header comment above), so the MQTT toggle always applies here
        // unconditionally.
        const live = {
            sensorSnap: liveTransport.getLiveSensorSnapshot(baseUrl),
            sysState:   liveTransport.getLiveSystemState(baseUrl),
        };
        const {
            isBrewing, pressure: presVal, temperature: tempVal, weight: weightVal,
            targetTemperature: tTempVal, profileName: profile, machineStatus,
        } = deriveMachineState(status, undefined, live);
        runtime.currentTemp       = tempVal  || runtime.currentTemp;
        runtime.currentTargetTemp = tTempVal || runtime.currentTargetTemp;
        runtime.machineStatus     = machineStatus;

        if (!state.cachedMachineVersion) {
            const ver = status.softwareVersion || status.version || status.firmware ||
                        status.buildNumber     || status.fw_version || status.buildDate || null;
            if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (from status): ${state.cachedMachineVersion}`); }
        }

        if (tempVal > 0 && !isBrewing) {
            runtime.tempHistory.push(tempVal);
            if (runtime.tempHistory.length > TEMP_HISTORY_MAX) runtime.tempHistory.shift();
            if (runtime.switchOnAt && tTempVal > 0 && tempVal >= tTempVal - 2 && isTempStable(runtime)) {
                const preheatMs = (Math.max(1, parseInt(opts.preheat_time) || 20)) * 60 * 1000;
                if (Date.now() - runtime.switchOnAt < preheatMs) {
                    runtime.switchOnAt     = Date.now() - preheatMs;
                    runtime.stabilityReady = true;
                    savePreheatState(runtime);
                    log('Temperature stable -- preheat marked complete');
                }
            }
        } else if (isBrewing) {
            runtime.tempHistory = [];
        }

        if (isBrewing && !state.liveAccum) {
            state.liveAccum = {
                startTime:   Date.now(),
                profileName: profile,
                prevWeight:  weightVal,
                datapoints: {
                    timeInShot: [], pressure: [], temperature: [],
                    shotWeight: [], weightFlow: [], pumpFlow: [], targetTemperature: []
                }
            };
            log(`Brew started: profile ${profile}`);
        }

        if (!isBrewing && state.liveAccum) {
            log('Brew finished');
            state.liveAccum = null;
            state.liveSeq++;
            setTimeout(syncAfterBrew, 3000);
        }

        if (isBrewing && state.liveAccum) {
            const elapsed    = Math.round((Date.now() - state.liveAccum.startTime) / 100);
            const weightFlow = Math.max(0, weightVal - state.liveAccum.prevWeight);
            state.liveAccum.prevWeight = weightVal;
            state.liveAccum.datapoints.timeInShot.push(elapsed);
            state.liveAccum.datapoints.pressure.push(Math.round(presVal * 10));
            state.liveAccum.datapoints.temperature.push(Math.round(tempVal * 10));
            state.liveAccum.datapoints.shotWeight.push(Math.round(weightVal * 10));
            state.liveAccum.datapoints.weightFlow.push(Math.round(weightFlow * 10));
            state.liveAccum.datapoints.pumpFlow.push(0);
            state.liveAccum.datapoints.targetTemperature.push(Math.round(tTempVal * 10));
        }
    } catch (err) {
        state.machineReachable = false;
        state.lastMachineError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        log(`Live poll error: ${err.message}`, true);
    }
}

async function checkAndApplyMachinePower(runtime = defaultRuntime) {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!entity || !HA_TOKEN) {
        if (!runtime.livePollTimer) startLivePolling(runtime);
        return;
    }
    const isOn = await getSwitchState(entity);
    if (isOn === null) return;
    if (isOn === runtime.machineOn) return;
    runtime.machineOn = isOn;
    if (isOn) {
        log('Machine on -- live polling and sync resumed');
        startLivePolling(runtime);
        setTimeout(syncShots, 2000);
    } else {
        log('Machine off -- live polling and sync paused');
        stopLivePolling(runtime);
        state.preheatNotifySent = false;
    }
}

async function backgroundHaCheck(runtime = defaultRuntime) {
    if (!HA_TOKEN) return;
    await checkAndApplyMachinePower(runtime);
    if (!state.cachedMachineVersion) fetchMachineVersion();
}

module.exports = {
    startLivePolling, stopLivePolling, pollLive, pollViaGaggiuinoStatus,
    checkAndApplyMachinePower, backgroundHaCheck, fetchMachineVersion,
};
