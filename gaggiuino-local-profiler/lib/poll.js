'use strict';
const axios = require('axios');
const { TEMP_HISTORY_MAX } = require('./constants');
const { log } = require('./helpers');
const { loadOptions, debugLog } = require('./data');
const { getSwitchState, HA_TOKEN } = require('./ha');
const registry = require('./machines/registry');
const state = require('./state');
const { getMachineRuntimeState } = require('./machine-runtime-state');
const { deriveMachineState, isStillWarm } = require('./machine-state');
const liveTransport = require('./live-transport');
const { savePreheatState, isTempStable } = require('./preheat');
const { syncAfterBrew, syncShots, fetchMachineVersion } = require('./sync');
const { summarizeConnectivity, WINDOW_MS: CONN_WINDOW_MS } = require('./connectivity-stats');

// #549: this module is hard single-machine (always the default/legacy
// machine, id 1) — one runtime instance obtained once at module load,
// same lifetime as the old lib/state.js singleton it replaces for these
// fields. Functions below still accept it as a parameter so callers (and
// tests) can pass a different instance instead of relying on this default.
const defaultRuntime = getMachineRuntimeState();

// #710: rolling window of pollViaGaggiuinoStatus() outcomes, module-scoped
// like the rest of this hard single-machine module (see #549 comment
// above) -- flushed to a debug-gated summary line once the window closes,
// so a flaky connection is diagnosable from the log alone instead of
// needing the user to run ping/curl by hand from the right host.
let _connWindow      = [];
let _connWindowStart = Date.now();

// #725: previous poll's reachability, module-scoped for the same
// hard-single-machine reason as _connWindow above -- lets a successful poll
// tell a genuine false->true recovery apart from "was already reachable,
// still is" (which must NOT re-trigger a sync every second). null (the
// initial/never-polled state) deliberately does NOT count as "was
// unreachable": the very first successful poll after a host is configured
// is covered by routes/machines.js's direct save-triggered sync instead, not
// by this recovery path.
let _wasReachable = null;

function recordConnectivity(ok, latencyMs, err) {
    _connWindow.push({ ok, latencyMs, err });
    const now = Date.now();
    if (now - _connWindowStart >= CONN_WINDOW_MS) {
        const summary = summarizeConnectivity(_connWindow);
        if (summary) debugLog(`Connectivity (last ${Math.round((now - _connWindowStart) / 1000)}s): ${summary}`);
        _connWindow      = [];
        _connWindowStart = now;
    }
}

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
    const opts = loadOptions();
    const startedAt = Date.now();
    try {
        const baseUrl = registry.baseUrlFor();
        // #718: null means no host configured anywhere -- skip cleanly,
        // don't request against a placeholder/fallback hostname.
        if (!baseUrl) return;
        // #714: URL of every request, not just failing ones (#709 already
        // covers those) -- a wrong/stale registry host that still resolves
        // to *something* was otherwise invisible until it happened to fail.
        debugLog(`GET ${baseUrl}/api/system/status`);
        const statusRes = await axios.get(`${baseUrl}/api/system/status`, { timeout: 3000 });
        recordConnectivity(true, Date.now() - startedAt, null);
        state.machineReachable   = true;
        state.lastMachineError   = null;
        state.lastMachineSuccess = Date.now();

        // #725: false->true reachability recovery, with either a known
        // outstanding sync failure or no successful sync ever recorded --
        // catch up now instead of waiting for the regular sync_interval
        // (default 5 min) to eventually notice. Fire-and-forget: this must
        // never block or fail the live poll itself. scheduleNextSync()'s own
        // timer chain (lib/sync.js) is untouched -- if it fires shortly
        // after this already succeeded, syncShots() just sees "already up
        // to date" and costs nothing.
        if (_wasReachable === false && (state.lastSyncError || !state.lastSyncTime)) {
            syncShots().catch(err => log(`Catch-up sync after reachability recovery failed: ${err.message}`, true));
        }
        _wasReachable = true;
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
            isBrewing, pressure: presVal, temperature: tempVal, weight: weightVal, pumpFlow: pumpFlowVal,
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
            // #709: isBrewing is derived purely from the REST poll's raw
            // status.brewSwitchState (see machine-state.js) -- logging it
            // plus upTime lets a rapid start/finish flap be told apart from
            // a genuine repeated brew after the fact: the same upTime
            // repeating across flaps would mean the machine is echoing a
            // stale/cached status rather than a fresh read each poll.
            debugLog(`Brew started detail: brewSwitchState=${status.brewSwitchState} upTime=${status.upTime}`);
        }

        if (!isBrewing && state.liveAccum) {
            log('Brew finished');
            debugLog(`Brew finished detail: brewSwitchState=${status.brewSwitchState} upTime=${status.upTime}`);
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
            state.liveAccum.datapoints.pumpFlow.push(Math.round(pumpFlowVal * 10));
            state.liveAccum.datapoints.targetTemperature.push(Math.round(tTempVal * 10));
        }
    } catch (err) {
        recordConnectivity(false, null, err.code || null);
        state.machineReachable = false;
        _wasReachable = false;
        state.lastMachineError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        log(`Live poll error: ${err.message}`, true);
    }
}

// #663: the physical machine can take longer than a couple of seconds to
// bring its own HTTP API up after power-on, so the first post-"machine on"
// sync attempt below can fail on a freshly booting machine. This one-off
// call is deliberately independent of lib/sync.js's own retry-with-backoff
// loop (scheduleNextSync(), SYNC_RETRY_DELAYS) -- that loop runs on its own
// schedule from server boot, unrelated to when the switch happens to flip
// on, and driving two schedulers off the same syncShots() call would need
// real coordination. A short, bounded retry here instead: a handful of
// attempts a fixed 10s apart, well under sync_interval's default 5 minutes
// (observed live: a single failed attempt left the status dot red for ~4
// minutes even though the machine was reachable again within seconds).
const POWER_ON_SYNC_RETRY_DELAY_MS = 10_000;
const POWER_ON_SYNC_MAX_ATTEMPTS   = 4;

function syncSoonAfterPowerOn(attempt = 0) {
    setTimeout(async () => {
        const ok = await syncShots();
        if (!ok && attempt + 1 < POWER_ON_SYNC_MAX_ATTEMPTS) syncSoonAfterPowerOn(attempt + 1);
    }, attempt === 0 ? 2000 : POWER_ON_SYNC_RETRY_DELAY_MS);
}

async function checkAndApplyMachinePower(runtime = defaultRuntime) {
    const entity = registry.switchEntityFor();
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
        syncSoonAfterPowerOn();
    } else {
        log('Machine off -- live polling and sync paused');
        stopLivePolling(runtime);
        state.preheatNotifySent = false;
        // #655: without this, state.machineReachable stayed frozen at
        // whatever it was just before the switch flipped off (usually
        // true) -- stopLivePolling() above is what actually stops the only
        // frequent prober of the machine's own reachability
        // (pollViaGaggiuinoStatus() below), and syncShots() (lib/sync.js)
        // short-circuits before its own network probe whenever this same
        // switchEntity reports the machine off, so nothing else would ever
        // flip it back to false. That's exactly why the status dot stayed
        // green for days after the machine was switched off. The switch
        // entity's own "off" report is itself an authoritative reachability
        // signal -- syncShots() already trusts it to skip its network call
        // -- so it's applied directly here instead of adding a separate
        // stale-timeout mechanism.
        state.machineReachable = false;
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
