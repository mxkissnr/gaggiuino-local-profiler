'use strict';
const axios = require('axios');
const {
    TEMP_HISTORY_MAX, TEMP_STABLE_MIN, WARM_TEMP_MIN, WARM_OFF_MAX_MS,
} = require('./constants');
const { log } = require('./helpers');
const { loadOptions, getMachineBaseUrl } = require('./data');
const { getSwitchState, HA_TOKEN } = require('./ha');
const state = require('./state');
const { savePreheatState, isTempStable } = require('./preheat');
const { syncAfterBrew, syncShots, fetchMachineVersion, scheduleNextSync } = require('./sync');

function startLivePolling() {
    if (state.livePollTimer) return;
    const offMs    = state.switchOffAt ? Date.now() - state.switchOffAt : 0;
    const coldOff  = offMs >= WARM_OFF_MAX_MS;
    const stillWarm = state.currentTemp !== null
        ? (state.currentTemp > WARM_TEMP_MIN && !coldOff)
        : (state.switchOnAt !== null && !coldOff);
    if (!state.switchOnAt || !stillWarm) { state.switchOnAt = Date.now(); savePreheatState(); }
    state.tempHistory = [];
    log('Live polling started via /api/system/status');
    state.livePollTimer = setInterval(pollLive, 1000);
}

function stopLivePolling() {
    if (!state.livePollTimer) return;
    clearInterval(state.livePollTimer);
    state.livePollTimer   = null;
    state.liveAccum       = null;
    state.switchOffAt     = Date.now();
    state.stabilityReady  = false;
    state.tempHistory     = [];
    savePreheatState();
    log('Live polling stopped');
}

async function pollLive() {
    if (state.isPollRunning) return;
    state.isPollRunning = true;
    try { await pollViaGaggiuinoStatus(); }
    finally { state.isPollRunning = false; }
}

async function pollViaGaggiuinoStatus() {
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const statusRes = await axios.get(`${baseUrl}/api/system/status`, { timeout: 3000 });
        state.machineReachable   = true;
        state.lastMachineError   = null;
        state.lastMachineSuccess = Date.now();
        const raw       = statusRes.data;
        const status    = Array.isArray(raw) ? raw[0] : raw;

        const isBrewing = !!status.brewSwitchState;
        const presVal   = parseFloat(status.pressure)          || 0;
        const tempVal   = parseFloat(status.temperature)       || 0;
        state.currentTemp = tempVal || state.currentTemp;
        const weightVal = parseFloat(status.weight)            || 0;
        const tTempVal  = parseFloat(status.targetTemperature) || 0;
        state.currentTargetTemp = tTempVal || state.currentTargetTemp;
        const profile   = status.profileName || 'Unknown';

        state.machineStatus = {
            temperature:       tempVal,
            targetTemperature: tTempVal,
            pressure:          presVal,
            waterLevel:        parseInt(status.waterLevel) || 0,
            weight:            weightVal,
            upTime:            parseInt(status.upTime)    || 0,
            profileId:         parseInt(status.profileId) || null,
            profileName:       status.profileName         || null,
            brewSwitchState:   !!status.brewSwitchState,
            steamSwitchState:  !!status.steamSwitchState,
            updatedAt:         Date.now(),
        };

        if (!state.cachedMachineVersion) {
            const ver = status.softwareVersion || status.version || status.firmware ||
                        status.buildNumber     || status.fw_version || status.buildDate || null;
            if (ver) { state.cachedMachineVersion = String(ver); log(`Gaggiuino firmware (from status): ${state.cachedMachineVersion}`); }
        }

        if (tempVal > 0 && !isBrewing) {
            state.tempHistory.push(tempVal);
            if (state.tempHistory.length > TEMP_HISTORY_MAX) state.tempHistory.shift();
            if (state.switchOnAt && tTempVal > 0 && tempVal >= tTempVal - 2 && isTempStable()) {
                const preheatMs = (Math.max(1, parseInt(opts.preheat_time) || 20)) * 60 * 1000;
                if (Date.now() - state.switchOnAt < preheatMs) {
                    state.switchOnAt     = Date.now() - preheatMs;
                    state.stabilityReady = true;
                    savePreheatState();
                    log('Temperature stable -- preheat marked complete');
                }
            }
        } else if (isBrewing) {
            state.tempHistory = [];
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

async function checkAndApplyMachinePower() {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!entity || !HA_TOKEN) {
        if (!state.livePollTimer) startLivePolling();
        return;
    }
    const isOn = await getSwitchState(entity);
    if (isOn === null) return;
    if (isOn === state.machineOn) return;
    state.machineOn = isOn;
    if (isOn) {
        log('Machine on -- live polling and sync resumed');
        startLivePolling();
        setTimeout(syncShots, 2000);
    } else {
        log('Machine off -- live polling and sync paused');
        stopLivePolling();
        state.preheatNotifySent = false;
    }
}

async function backgroundHaCheck() {
    if (!HA_TOKEN) return;
    await checkAndApplyMachinePower();
    if (!state.cachedMachineVersion) fetchMachineVersion();
}

module.exports = {
    startLivePolling, stopLivePolling, pollLive, pollViaGaggiuinoStatus,
    checkAndApplyMachinePower, backgroundHaCheck, fetchMachineVersion,
};
