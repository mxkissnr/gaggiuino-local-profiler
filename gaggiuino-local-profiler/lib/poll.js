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
const { events: liveEvents } = require('./gaggiuino-live-client');
const { savePreheatState, isTempStable, buildPreheatResponse } = require('./preheat');
const { syncAfterBrew, syncShots, fetchMachineVersion } = require('./sync');
const { summarizeConnectivity, WINDOW_MS: CONN_WINDOW_MS } = require('./connectivity-stats');
const { bus, EVENTS } = require('./events');

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

// #708: a fresh WS/MQTT sample previously just sat in liveTransport's cache
// until the next tick of the 1s interval below read it -- up to ~1s of pure
// waiting on top of the transport's own latency. gaggiuino-live-client.js's
// `events` emitter (reused by gaggiuino-mqtt-client.js, see its own header
// comment) fires the instant either transport's cache updates, so
// startLivePolling()/stopLivePolling() bridge that straight into an
// immediate LIVE_SNAPSHOT instead of waiting for the tick. Module-scoped
// like _wasReachable/_connWindow above, for the same hard-single-machine
// reason (see the header comment) -- there is only ever one bridge to
// attach/detach, regardless of which runtime instance happens to call
// start/stop.
const LIVE_SNAPSHOT_THROTTLE_MS = 150;
let _lastLiveSnapshotEmitAt = 0;
let _liveEventBridgeActive = false;

// Single emit path for every LIVE_SNAPSHOT push (tick, event-triggered,
// stop, error) so the throttle timestamp below is always accurate --
// callers that must never be swallowed (state transitions on stop/error)
// call this directly and unconditionally; onLiveTransportEvent() below is
// the only path that checks the timestamp before calling it.
function emitLiveSnapshot() {
    _lastLiveSnapshotEmitAt = Date.now();
    bus.emit(EVENTS.LIVE_SNAPSHOT, buildLiveDataResponse());
}

// Not filtered by connection identity: WS sessions key by baseUrl, MQTT
// sessions key by host:port:prefix (see gaggiuino-mqtt-client.js's
// connKeyFor()) -- there's no shared identity format to match against, and
// this module already only ever tracks the single default/legacy machine
// (see header comment), so any event on the shared bus is "the" default
// machine's regardless of which transport produced it. A burst of rapid
// MQTT messages shouldn't turn into an SSE frame per message, hence the
// throttle.
function onLiveTransportEvent() {
    if (Date.now() - _lastLiveSnapshotEmitAt < LIVE_SNAPSHOT_THROTTLE_MS) return;
    emitLiveSnapshot();
}

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

// #736: single source of truth for GET /api/live/data's response shape,
// also used to build the LIVE_SNAPSHOT SSE payload from pollViaGaggiuinoStatus()
// below -- avoids duplicating the same field-mapping in two places. Reads
// straight off the module-scoped `state` (not the passed-in runtime), same
// as the route it replaces: state.liveAccum/liveSeq/machineReachable are
// hard single-machine already, per this file's header comment.
function buildLiveDataResponse() {
    return {
        isLive:           !!state.liveAccum,
        profileName:      state.liveAccum?.profileName || '',
        datapoints:       state.liveAccum ? state.liveAccum.datapoints : null,
        seq:              state.liveSeq,
        // #655: without this, a powered-off machine looked identical to an
        // idle-but-reachable one (state.liveAccum is null either way) — the
        // live tab kept showing "Ready to brew" indefinitely.
        machineReachable: state.machineReachable,
    };
}

function startLivePolling(runtime = defaultRuntime) {
    if (runtime.livePollTimer) return;
    if (!runtime.switchOnAt || !isStillWarm(runtime)) { runtime.switchOnAt = Date.now(); savePreheatState(runtime); }
    runtime.tempHistory = [];
    log('Live polling started via /api/system/status');
    runtime.livePollTimer = setInterval(() => pollLive(runtime), 1000);
    // #708: bridge the transport's own push-on-arrival events into an
    // immediate LIVE_SNAPSHOT -- see the bridge functions' own comments above.
    if (!_liveEventBridgeActive) {
        liveEvents.on('sensor-snap', onLiveTransportEvent);
        liveEvents.on('sys-state', onLiveTransportEvent);
        _liveEventBridgeActive = true;
    }
    // #736: immediate push so the Ready badge/preheat widget update the
    // instant polling (re)starts, instead of waiting for the 30s watcher tick.
    bus.emit(EVENTS.PREHEAT_UPDATE, buildPreheatResponse(runtime));
}

function stopLivePolling(runtime = defaultRuntime) {
    // #655: the switch entity's own "off" report is itself an authoritative
    // reachability signal -- applied unconditionally, even when there was no
    // active live-poll timer to actually stop below (e.g. this being called
    // on a runtime that never reached startLivePolling() in the first
    // place), so nothing is ever left able to flip this back to false on its
    // own. Previously set by the one and only caller
    // (checkAndApplyMachinePower's machine-off branch) right after calling
    // this function; moved in here so the LIVE_SNAPSHOT push below always
    // reflects it, never the stale pre-flip value.
    state.machineReachable = false;
    if (runtime.livePollTimer) {
        clearInterval(runtime.livePollTimer);
        runtime.livePollTimer  = null;
        state.liveAccum        = null;
        runtime.switchOffAt    = Date.now();
        runtime.stabilityReady = false;
        runtime.tempHistory    = [];
        savePreheatState(runtime);
        // #708: matching teardown for the bridge attached in
        // startLivePolling() -- without this a stop/start cycle (MQTT toggle,
        // add-on restart) would leak a listener per cycle.
        if (_liveEventBridgeActive) {
            liveEvents.off('sensor-snap', onLiveTransportEvent);
            liveEvents.off('sys-state', onLiveTransportEvent);
            _liveEventBridgeActive = false;
        }
        log('Live polling stopped');
    }
    // #736: emit both push types on stop, not just PREHEAT_UPDATE -- without
    // a LIVE_SNAPSHOT here too, an SSE-connected Live tab client never
    // learns the machine went offline: pollViaGaggiuinoStatus()'s 1s loop
    // (the only other LIVE_SNAPSHOT emitter) is exactly what this function
    // just stopped, and the frontend's own fetchLiveData() fallback poll is
    // skipped while SSE is active -- reintroducing #655's bug class for the
    // SSE path specifically. Unconditional (not nested in the `if` above) so
    // the machineReachable:false flip is always broadcast, even on the
    // no-active-timer path.
    bus.emit(EVENTS.PREHEAT_UPDATE, buildPreheatResponse(runtime));
    emitLiveSnapshot();
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
                    // #736: immediate push on the stability-ready flip, instead
                    // of waiting for the 30s preheat watcher tick.
                    bus.emit(EVENTS.PREHEAT_UPDATE, buildPreheatResponse(runtime));
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
            // #709/#902: isBrewing is derived from the REST poll's raw
            // status.brewSwitchState AND, once a live transport is connected,
            // live.sensorSnap.brewActive (see machine-state.js) -- logging
            // both plus upTime lets a rapid start/finish flap be told apart
            // from a genuine repeated brew after the fact: the same upTime
            // repeating across flaps would mean the machine is echoing a
            // stale/cached status rather than a fresh read each poll, and
            // brewSwitchState=true with brewActive=false distinguishes a
            // BREW_AUTO auto-stop (switch still up, brew genuinely over)
            // from an actual switch flap.
            debugLog(`Brew started detail: brewSwitchState=${status.brewSwitchState} sensorBrewActive=${live.sensorSnap?.brewActive} upTime=${status.upTime}`);
        }

        if (!isBrewing && state.liveAccum) {
            log('Brew finished');
            debugLog(`Brew finished detail: brewSwitchState=${status.brewSwitchState} sensorBrewActive=${live.sensorSnap?.brewActive} upTime=${status.upTime}`);
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

        // #736: broadcast this tick's live snapshot -- same shape GET
        // /api/live/data returns, single source of truth via
        // buildLiveDataResponse() above.
        emitLiveSnapshot();
    } catch (err) {
        recordConnectivity(false, null, err.code || null);
        state.machineReachable = false;
        _wasReachable = false;
        state.lastMachineError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        log(`Live poll error: ${err.message}`, true);
        // #736: also broadcast on the error path -- machineReachable just
        // flipped false, and the live view needs that transition in real time.
        emitLiveSnapshot();
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
        // #655/#736: stopLivePolling() itself now sets state.machineReachable
        // = false (moved there so its LIVE_SNAPSHOT push reflects the flip
        // instead of the stale pre-flip value) -- see its own comment for
        // the full "why this must happen at all" reasoning.
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
    checkAndApplyMachinePower, backgroundHaCheck, fetchMachineVersion, buildLiveDataResponse,
};
